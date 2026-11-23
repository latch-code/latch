import LatchNativeCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/** The same copy rule as the conversation's own text: this device only, gone in two minutes. */
@MainActor enum LocalClipboard {
    static func copy(_ text: String, to pasteboard: UIPasteboard = .general) {
        write([UTType.utf8PlainText.identifier: text], to: pasteboard)
    }
    static func copy(png: Data) {
        write([UTType.png.identifier: png])
    }
    private static func write(_ item: [String: Any], to pasteboard: UIPasteboard = .general) {
        pasteboard.setItems([item], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
    }
}

/** A subagent on the turn's rail: its name, what it last said of itself, 停止 where its Harness can stop it alone. */
struct SubagentRowView: View {
    @EnvironmentObject private var model: PhoneModel
    let message: NativeJSON
    @State private var expanded = false
    var body: some View {
        if let row = PhoneSubagents.row(message, requested: message["id"].string.map { model.subagentStops.contains($0) } ?? false,
            canStop: model.connected && model.hasScope("view") && model.verifiedUntil != nil) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Button { if !row.steps.isEmpty { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } } label: {
                        HStack(spacing: 8) {
                            Group {
                                if row.stopping || (message["subagent"]["status"].string == "running" && model.connected) { ProgressView().controlSize(.mini).tint(PhoneTheme.accent) }
                                else { Image(systemName: "person.2").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted) }
                            }.frame(width: 18)
                            (Text("子 Agent ") + Text(row.title)).font(.system(size: 14)).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
                            if !row.steps.isEmpty { Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(PhoneTheme.faint) }
                            Spacer(minLength: 4)
                            if let status = row.status {
                                Text(status).font(PhoneTheme.caption).foregroundStyle(row.waiting ? PhoneTheme.amber : row.status == "失败" ? PhoneTheme.red : PhoneTheme.muted).lineLimit(1)
                            }
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    if row.canStop {
                        Button("停止") { Task { await model.stopSubagent(row.id) } }
                            .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.mini).tint(PhoneTheme.ink)
                            .accessibilityLabel("停止子 Agent " + row.title)
                    }
                }
                if expanded {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(row.steps.enumerated()), id: \.offset) { _, step in
                            Text(stepWords(step)).font(.system(size: 13)).foregroundStyle(PhoneTheme.muted).lineLimit(2)
                        }
                    }.padding(.leading, 26)
                }
            }
        }
    }
    /** What a step said or did, read only. */
    private func stepWords(_ step: NativeJSON) -> String {
        if step["role"].string == "tool" { let label = PhoneConversation.toolLabel(step); return [label.verb, label.object].compactMap { $0 }.joined(separator: " ") }
        return (step["text"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/** Under a settled turn: 复制, 重试 and 从这里分叉, with the web's confirmation before a retry that may repeat something. */
struct TurnActionBar: View {
    @EnvironmentObject private var model: PhoneModel
    let actions: PhoneTurnActions
    let index: Int
    let turn: PhoneTurn
    @State private var confirming = false
    @State private var copied = false
    /** The turn's last message: 复制到这里为止的记录 ends there. */
    private var end: String? { (turn.replies.last ?? turn.user)?["id"].string.flatMap { $0.hasPrefix("live:") ? nil : $0 } }
    private var canHandOff: Bool {
        model.canRun && model.connected && model.snapshot["catalog"]["features"]["handoffs"].bool && model.currentSummary["personal"] == .null
            && !PhoneHandoffs.materials(turn).isEmpty
    }
    var body: some View {
        HStack(spacing: 4) {
            if let text = actions.copy {
                icon(copied ? "checkmark" : "doc.on.doc", label: "复制") {
                    LocalClipboard.copy(text); copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                }
            }
            if let retry = actions.retry {
                icon("arrow.counterclockwise", label: "重试") { if retry.warning != nil { confirming = true } else { resend(retry) } }
                    .disabled(model.busy || !model.pending.isEmpty)
            }
            if let end = actions.forkFrom { icon("arrow.triangle.branch", label: "从这里分叉") { model.beginFork(turn: index, upTo: end) } }
            if canHandOff || end != nil {
                Menu {
                    if canHandOff, let id = model.sessionId {
                        Button("交给代码任务…", systemImage: "arrow.turn.down.right") { model.handoffDraft = PhoneHandoffDraft(sourceSessionId: id, materials: PhoneHandoffs.materials(turn)) }
                    }
                    if let end {
                        Button("复制到这里为止的记录", systemImage: "doc.on.doc") {
                            LocalClipboard.copy(PhoneMarkdown.transcript(model.detail, harness: model.engineName(model.currentSummary["harnessId"].string), upTo: end))
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 13)).foregroundStyle(PhoneTheme.muted).frame(width: 32, height: 32).contentShape(Rectangle())
                }.accessibilityLabel("更多")
            }
        }
        .confirmationDialog("重试", isPresented: $confirming, titleVisibility: .hidden) {
            if let retry = actions.retry { Button("重试") { resend(retry) } }
            Button("取消", role: .cancel) {}
        } message: { Text(actions.retry?.warning ?? "") }
    }
    private func resend(_ retry: PhoneRetry) { Task { await model.send(text: retry.prompt) } }
    private func icon(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(PhoneTheme.muted).frame(width: 32, height: 32).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(label)
    }
}

/** The same actions held down on any settled turn. */
struct TurnActionsMenu: View {
    @EnvironmentObject private var model: PhoneModel
    let actions: PhoneTurnActions
    let index: Int
    var body: some View {
        if let text = actions.copy { Button("复制", systemImage: "doc.on.doc") { LocalClipboard.copy(text) } }
        if let end = actions.forkFrom { Button("从这里分叉", systemImage: "arrow.triangle.branch") { model.beginFork(turn: index, upTo: end) } }
    }
}

/** The one session menu's buttons, for a Menu, a held row or a swipe. */
struct SessionMenuButtons: View {
    @EnvironmentObject private var model: PhoneModel
    let task: NativeJSON
    var open = false
    var body: some View {
        let clear = open ? (offered: model.detail["clearContext"].bool && model.detail["summary"]["id"].string == task["id"].string,
            clearing: task["id"].string.map { model.clearing.contains($0) } ?? false) : nil
        let copy = open && model.detail["summary"]["id"].string == task["id"].string && !model.detail["messages"].array.isEmpty
        ForEach(Array(PhoneSessionMenu.sections(task, canRun: model.canRun, clear: clear, copy: copy, retained: PhoneAgentChat.isCurrent(model.snapshot, task: task)).enumerated()), id: \.offset) { _, section in
            Section {
                ForEach(section) { item in
                    Button(role: item.action == .delete ? .destructive : nil) { Task { await model.choose(item.action, task: task) } } label: {
                        if let reason = item.disabledReason { Label { Text(item.label); Text(reason) } icon: { Image(systemName: item.symbol) } }
                        else { Label(item.label, systemImage: item.symbol) }
                    }.disabled(item.disabledReason != nil || model.busy || !model.connected)
                }
            }
        }
    }
}

/** 重命名 and 删除, asked once for the list and the conversation alike. */
struct SessionDialogs: ViewModifier {
    @EnvironmentObject private var model: PhoneModel
    func body(content: Content) -> some View {
        content
            .alert("重命名会话", isPresented: Binding(get: { model.renaming != nil }, set: { if !$0 { model.renaming = nil } })) {
                TextField("会话名称", text: $model.renameDraft)
                Button("取消", role: .cancel) { model.renaming = nil }
                Button("保存") {
                    if let task = model.renaming { let title = model.renameDraft; Task { _ = await model.rename(task, title: title) } }
                    model.renaming = nil
                }.disabled((try? PhoneSessionWrite.rename("x", title: model.renameDraft)) == nil)
            }
            // A dialog, as the web's: an action sheet has no place to anchor beside an iPad's list.
            .alert("删除会话", isPresented: Binding(get: { model.deleting != nil }, set: { if !$0 { model.deleting = nil } })) {
                Button("删除", role: .destructive) {
                    if let task = model.deleting { Task { await model.delete(task) } }
                    model.deleting = nil
                }
                Button("取消", role: .cancel) { model.deleting = nil }
            } message: { Text(model.deleting.map(PhoneSessionMenu.deleteQuestion) ?? "") }
    }
}

/** 下一条消息开始新的上下文, with 保留上下文 while this phone chose it and nothing was sent. */
struct ClearingDrawer: View {
    @EnvironmentObject private var model: PhoneModel
    let sessionId: String
    let engine: String
    var body: some View {
        let hostCleared = PhoneConversation.clearedNote(model.detail, engine: engine)
        if model.clearing.contains(sessionId) || hostCleared != nil {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "eraser").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted)
                VStack(alignment: .leading, spacing: 2) {
                    Text("下一条消息开始新的上下文").font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink)
                    if let hostCleared { Text(hostCleared.line).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                }
                Spacer(minLength: 0)
                if hostCleared == nil {
                    Button("保留上下文") { model.toggleClearing(sessionId) }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink)
                }
            }.padding(.horizontal, 16).accessibilityElement(children: .contain)
        }
    }
}

/** 权限, 模型 and 思考 the Harness reported for this session, each its own menu in the input box. */
struct ConfigChips: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var settingNote: String?
    let controls: [PhoneConfigControl]
    let chip: (AnyView) -> AnyView
    var body: some View {
        ForEach(controls) { control in
            Menu {
                let main = control.rows.filter { !$0.more }, more = control.rows.filter(\.more)
                Section(control.title) { ForEach(main) { row in rowButton(control, row) } }
                if !more.isEmpty { Menu("更多") { ForEach(more) { row in rowButton(control, row) } } }
                if let note = control.note, let detail = control.noteDetail {
                    Section { Button(note, systemImage: "info.circle") { settingNote = detail } }
                }
            } label: {
                chip(AnyView(HStack(spacing: 6) {
                    if control.kind == .permission { Image(systemName: control.amber ? "exclamationmark.shield" : "shield").font(.system(size: 12)) }
                    if control.kind == .thinking { Image(systemName: "brain").font(.system(size: 12)) }
                    Text(control.label).foregroundStyle(control.amber ? PhoneTheme.amber : PhoneTheme.ink2)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                }))
            }
            .disabled(model.busy || !model.pending.isEmpty || !model.connected)
            .accessibilityLabel([control.title, control.label, control.note].compactMap { $0 }.joined(separator: " · "))
        }
        .alert("启动设置", isPresented: Binding(get: { settingNote != nil }, set: { if !$0 { settingNote = nil } })) {
            Button("知道了", role: .cancel) { settingNote = nil }
        } message: { Text(settingNote ?? "") }
    }
    private func rowButton(_ control: PhoneConfigControl, _ row: PhoneConfigRow) -> some View {
        Button { if !row.current || control.kind == .permission || control.source == .launch { Task { await model.setConfig(control.configId, value: row.value) } } } label: {
            if row.current { Label { Text(row.name); if let line = row.line { Text(line) } } icon: { Image(systemName: "checkmark") } }
            else { Label { Text(row.name); if let line = row.line { Text(line) } } icon: { EmptyView() } }
        }
    }
}

/** 内容中包含: the Host's full-text hits under the list's own matches. */
struct ContentSearchSection: View {
    @EnvironmentObject private var model: PhoneModel
    let query: String
    var body: some View {
        let search = model.contentSearch
        Section {
            if model.verifiedUntil == nil {
                Text("查看内容后可以搜索正文").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            } else if search.loading || search.query != query {
                Text("正在搜索正文…").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            } else if let error = search.error {
                Text(error).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            } else if search.hits.isEmpty {
                Text("没有匹配的正文").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            } else {
                ForEach(search.hits) { hit in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(hit.title.isEmpty ? "未命名会话" : hit.title).font(.system(size: 15)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                            if hit.archived { Text("已归档").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted) }
                        }
                        (Text(hit.before) + Text(hit.match).foregroundColor(PhoneTheme.ink).bold() + Text(hit.after))
                            .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(2)
                    }.tag(hit.sessionId).accessibilityElement(children: .combine)
                }
                if search.truncated { Text("已显示部分结果，请缩小搜索范围。").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            }
        } header: {
            Text("内容中包含").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted).textCase(nil)
        }
        .listRowBackground(Color.clear)
    }
}
