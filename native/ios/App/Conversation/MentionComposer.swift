import LatchNativeCore
import SwiftUI
import UIKit

/** A file picked in one draft cannot grant a reference to the same spelling on another computer or project. */
struct MentionContext: Equatable {
    let scope: PhoneMentionScope?
    let host: UUID
    let window: UUID
    let dataScope: String?
    let owner: String?

    @MainActor init(_ model: PhoneModel, scope: PhoneMentionScope?, owner: String?) {
        self.scope = scope; self.owner = owner
        host = model.generation; window = model.privateSnapshot.epoch; dataScope = model.snapshot["device"]["dataScope"].string
    }
}

@MainActor final class MentionState: ObservableObject {
    fileprivate struct Search: Equatable {
        let context: MentionContext
        let reading: UUID
        let transport: NativeTransportEpoch?
        let team: String?
        let token: PhoneFileMentionToken
    }
    fileprivate enum Result { case files(PhoneFileMatches), failed }
    @Published fileprivate var loaded: (search: Search, result: Result)?
    fileprivate var previousToken: PhoneFileMentionToken?
    @Published fileprivate var dismissed: Search?
    @Published fileprivate var highlighted: MentionOption.ID?
    @Published fileprivate var picks: [PhoneFileMatches.Hit] = []
    fileprivate var pickedIn: MentionContext?

    func clear() {
        loaded = nil; dismissed = nil; highlighted = nil; previousToken = nil; picks = []; pickedIn = nil
    }
}

/** The three conversation inputs share the editor's live UTF-16 selection and the Host's explicit file choices. */
@MainActor struct MentionComposer: DynamicProperty {
    @ObservedObject var model: PhoneModel
    @ObservedObject var state: MentionState
    @ObservedObject var editor: SlashComposerState
    let text: Binding<String>
    let context: MentionContext
    let enabled: Bool
    var sourceText: String? = nil
    struct Personal {
        let entries: [PhoneAgentEntry]
        let blocked: String?
        let select: (PhoneAgentEntry) -> Void
    }
    var personal: Personal?
    var handlesToken: Bool { search != nil }

    static func project(_ choice: PhoneStartChoice) -> PhoneMentionScope? {
        guard let project = choice.workspaceId, project != "default", let harness = choice.harnessId else { return nil }
        return .project(workspace: project, harness: harness)
    }

    var references: [PhoneFileMatches.Hit] {
        guard state.pickedIn == context else { return [] }
        let draft = sourceText ?? text.wrappedValue
        return state.picks.filter { PhoneFileMentionToken.contains(root: $0.root, path: $0.path, in: draft) }
    }
    private var current: Bool {
        context == MentionContext(model, scope: context.scope, owner: context.owner)
            && model.transportReady && model.hasContentWindow && model.canRun
    }
    var team: PhoneMemberMentions? {
        guard case let .session(session) = context.scope, model.sessionId == session,
              model.detail["summary"]["id"].string == session, model.privateSnapshot.confirmed, current else { return nil }
        return PhoneMemberMentions(snapshot: model.snapshot, session: session)
    }
    var markers: [PromptMentionChip] {
        guard text.wrappedValue.contains("@") else { return [] }
        let members = team?.members.map {
            PromptMentionChip(marker: $0.token, name: $0.name, icon: .member(model.engineMark($0.harnessId)))
        } ?? []
        return members + references.map {
            PromptMentionChip(marker: "@\($0.root):\($0.path)", name: $0.name, icon: .file)
        }
    }

    fileprivate var search: MentionState.Search? {
        guard enabled, !editor.composing, let scope = context.scope,
              let token = PhoneFileMentionToken.active(in: text.wrappedValue, selection: editor.selection, continuing: state.previousToken), current else { return nil }
        if case let .session(id) = scope, model.sessionId != id { return nil }
        let team = team?.teamId
        guard team != nil || scope.supported(in: model.snapshot) else { return nil }
        return .init(context: context, reading: model.contentGeneration, transport: model.installedTransport, team: team, token: token)
    }
    fileprivate var openSearch: MentionState.Search? {
        guard let search, state.dismissed != search else { return nil }
        return search
    }
    fileprivate var offersFiles: Bool { context.scope?.supported(in: model.snapshot) == true }
    fileprivate var canReadFiles: Bool { offersFiles && PhoneWorkItems.canReadFiles(model.snapshot) }
    fileprivate func page(_ search: MentionState.Search) -> PhoneFileMatches? {
        guard canReadFiles, let loaded = state.loaded, loaded.search == search, case let .files(page) = loaded.result else { return nil }
        return page
    }
    fileprivate func options(_ search: MentionState.Search) -> [MentionOption] {
        let members = team?.matching(search.token.query).map(MentionOption.member) ?? []
        let picked = references
        let agents = personal?.entries.map { MentionOption.agent($0, blocked: personal?.blocked) } ?? []
        return agents + members + (page(search)?.files ?? []).map { file in
            .file(file, limited: picked.count >= 32 && !picked.contains(where: { $0.id == file.id }))
        }
    }
    fileprivate func active(_ search: MentionState.Search, choices: [MentionOption]) -> MentionOption.ID? {
        if let id = state.highlighted, choices.contains(where: { $0.id == id && !$0.disabled }) { return id }
        return search.token.query.isEmpty ? nil : choices.first { !$0.disabled }?.id
    }
    fileprivate func choose(_ option: MentionOption, search: MentionState.Search) {
        guard openSearch == search, let row = options(search).first(where: { $0.id == option.id }), !row.disabled else { return }
        let edit: (text: String, selection: NSRange)?
        switch row {
        case let .agent(entry, _):
            personal?.select(entry)
            return
        case let .member(member):
            edit = search.token.inserting(marker: member.token, in: text.wrappedValue, selection: editor.selection)
        case let .file(file, _):
            edit = search.token.inserting(root: file.root, path: file.path, in: text.wrappedValue, selection: editor.selection)
            guard edit != nil else { return }
            let kept = references.filter { $0.id != file.id }
            state.pickedIn = context; state.picks = kept + [file]
        }
        guard let edit else { return }
        text.wrappedValue = edit.text
        editor.selection = edit.selection
        editor.selectionRequest = EditorSelectionRequest(text: edit.text, range: edit.selection)
    }
    var isOpen: Bool { openSearch != nil }
    private func waiting(for search: MentionState.Search) -> Bool {
        canReadFiles && !search.token.query.isEmpty && search.token.query.utf16.count <= 512 && state.loaded?.search != search
    }
    var keys: [String] {
        guard let search = openSearch else { return [] }
        let choices = options(search)
        var keys = [UIKeyCommand.inputEscape]
        if choices.contains(where: { !$0.disabled }) { keys += [UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow] }
        if active(search, choices: choices) != nil || waiting(for: search) { keys += ["\t", "\r"] }
        return keys
    }
    func handle(_ key: String) -> Bool {
        guard let search = openSearch, keys.contains(key) else { return false }
        if key == UIKeyCommand.inputEscape { state.dismissed = search; return true }
        let choices = options(search).filter { !$0.disabled }
        guard !choices.isEmpty else { return waiting(for: search) }
        let index = active(search, choices: choices).flatMap { id in choices.firstIndex { $0.id == id } }
        switch key {
        case UIKeyCommand.inputUpArrow: state.highlighted = choices[((index ?? 0) + choices.count - 1) % choices.count].id
        case UIKeyCommand.inputDownArrow: state.highlighted = choices[((index ?? -1) + 1) % choices.count].id
        default: if let index { choose(choices[index], search: search) }
        }
        return true
    }
}

private enum MentionOption: Identifiable {
    enum ID: Hashable { case agent(String), member(String), file(Data) }
    case agent(PhoneAgentEntry, blocked: String?)
    case member(PhoneMemberMentions.Member)
    case file(PhoneFileMatches.Hit, limited: Bool)
    var id: ID {
        switch self { case let .agent(entry, _): .agent(entry.id); case let .member(member): .member(member.id); case let .file(file, _): .file(file.id) }
    }
    var disabled: Bool {
        switch self { case let .agent(entry, blocked): !entry.available || blocked != nil; case let .member(member): member.disabled != nil; case let .file(_, limited): limited }
    }
    var isAgent: Bool { if case .agent = self { return true }; return false }
    var isMember: Bool { if case .member = self { return true }; return false }
}

struct MentionSuggestions: View {
    let input: MentionComposer
    let maximumHeight: CGFloat
    @State private var retry = 0

    var body: some View {
        Group {
            if let search = input.openSearch, maximumHeight >= 44 {
                list(search)
                    .task(id: search) { await load(search) }
                    .id(retry)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(input.personal != nil ? "选择协作 Agent 或引用" : search.team == nil ? "引用项目文件" : "提到成员或文件")
            }
        }
        .onChange(of: input.search) { _, now in
            input.state.previousToken = now?.token
            if input.state.dismissed != now { input.state.dismissed = nil }
            if input.state.loaded?.search != now { input.state.loaded = nil; input.state.highlighted = nil }
        }
    }

    private func load(_ search: MentionState.Search) async {
        guard input.canReadFiles, let scope = search.context.scope, search.token.query.utf16.count <= 512 else { return }
        do {
            try await Task.sleep(for: .milliseconds(160))
            let page = try await input.model.findMentionFiles(search.token.query, in: scope)
            guard !Task.isCancelled, input.openSearch == search else { return }
            input.state.loaded = (search, .files(page))
        } catch {
            guard !Task.isCancelled, input.openSearch == search else { return }
            input.state.loaded = (search, .failed)
        }
    }
    private func notice(_ search: MentionState.Search, choices: [MentionOption]) -> String? {
        if !input.offersFiles { return choices.isEmpty ? "没有匹配的成员" : nil }
        if !input.canReadFiles { return choices.isEmpty ? "这台设备看不到项目文件。可在 Mac 的「设置 › 设备」中开启权限。" : nil }
        if search.token.query.utf16.count > 512 { return "请缩短搜索词" }
        guard let loaded = input.state.loaded, loaded.search == search else { return "正在查找文件…" }
        if case .failed = loaded.result { return "暂时无法搜索项目文件" }
        if input.references.count >= 32 { return "每条消息最多引用 32 个文件" }
        if input.page(search)?.truncated == true { return "继续输入可缩小范围" }
        return choices.isEmpty ? (search.team == nil ? "没有匹配的文件" : "没有匹配的成员或文件") : nil
    }
    private func list(_ search: MentionState.Search) -> some View {
        let choices = input.options(search)
        let agents = choices.filter(\.isAgent), members = choices.filter(\.isMember), files = choices.filter { !$0.isMember && !$0.isAgent }
        let active = input.active(search, choices: choices)
        let note = notice(search, choices: choices)
        let fileHeader = (!agents.isEmpty || !members.isEmpty) && (!files.isEmpty || note != nil) && input.offersFiles
        let groups = (agents.isEmpty ? 0 : 1) + (members.isEmpty ? 0 : 1) + (fileHeader ? 1 : 0)
        let height = CGFloat(choices.count + (note == nil ? 0 : 1)) * 44 + CGFloat(groups) * 24
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !agents.isEmpty { header("选择协作 Agent") }
                    ForEach(agents) { row($0, search: search, active: active) }
                    if !members.isEmpty { header("成员") }
                    ForEach(members) { row($0, search: search, active: active) }
                    if fileHeader { header("文件") }
                    ForEach(files) { row($0, search: search, active: active) }
                    if let note {
                        HStack {
                            Text(note).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                            if let loaded = input.state.loaded, loaded.search == search, case .failed = loaded.result {
                                Spacer(); Button("重试") { input.state.loaded = nil; retry += 1 }
                            }
                        }.padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                }
            }
            .frame(height: min(maximumHeight, 198, max(44, height)))
            .background(PhoneTheme.raised).clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(PhoneTheme.line).allowsHitTesting(false) }
            .onChange(of: active) { _, id in if let id { proxy.scrollTo(id) } }
        }
    }
    private func header(_ words: String) -> some View {
        Text(words).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(.horizontal, 12)
            .frame(height: 24).accessibilityAddTraits(.isHeader)
    }
    private func row(_ option: MentionOption, search: MentionState.Search, active: MentionOption.ID?) -> some View {
        Button { input.choose(option, search: search) } label: {
            HStack(spacing: 8) {
                switch option {
                case let .agent(entry, blocked):
                    AgentFace(avatar: entry.avatar, size: 28, face: entry.face)
                    title(entry.name, detail: blocked ?? (entry.available ? entry.duty : "不可用"))
                case let .member(member):
                    EngineTile(mark: input.model.engineMark(member.harnessId), size: 18)
                    title(member.name, detail: member.disabled ?? (member.title == member.name ? input.model.engineName(member.harnessId) : member.title))
                    Spacer(minLength: 0)
                    Text(PhoneTeamReturn.words(member.state)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                case let .file(file, _):
                    Image(systemName: "doc").foregroundStyle(PhoneTheme.muted).accessibilityHidden(true)
                    let folder = (file.path as NSString).deletingLastPathComponent
                    title(file.name, detail: [file.root == "default" ? "" : file.root, folder].filter { !$0.isEmpty }.joined(separator: " · "), file: true)
                    if file.ignored { Text("已忽略").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                }
            }.padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle()).background(active == option.id ? PhoneTheme.bubble : .clear)
        }.buttonStyle(.plain).disabled(option.disabled).id(option.id)
    }
    private func title(_ name: String, detail: String, file: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(PhoneConversation.visible(name)).font(.system(size: 14, design: file ? .monospaced : .default))
            if !detail.isEmpty { Text(PhoneConversation.visible(detail)).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
        }.lineLimit(1).truncationMode(.middle)
    }
}
