import LatchNativeCore
import SwiftUI
import UIKit

/** One prompt and its answer. Prose never folds; a turn's work folds away only once it has answered. */
struct TurnView: View, Equatable {
    @EnvironmentObject private var model: PhoneModel
    let session: String
    let turn: PhoneTurn
    let latest: Bool
    let status: String?
    let running: Bool
    /** The Mac is out of reach, so nothing here may look as if it is still moving. */
    let frozen: Bool
    let delivery: String?
    /** The model or thinking changed from the turn before, as `from → to`. */
    let switched: String?
    let mark: String?
    let engine: String
    var helper: PhoneAgentEntry? = nil
    var fileScope = PhoneFileScope()
    /** The prompt is a team's results the Host sent: drawn as their card, not as the person's words. */
    var teamCard: PhoneTeamReturn.Card? = nil
    /** The run's own line says how it ended, so the footer does not say it twice. */
    let endSaid: Bool
    /** 复制, 重试 and 从这里分叉, and where the turn is in the session. */
    var actions = PhoneTurnActions.none
    var index = 0
    let open: (String, String?) -> Void
    @State private var unfolded = false
    /** An earlier turn shows its actions once its author line is tapped, as the web's touch layout does. */
    @State private var tapped = false
    nonisolated static func == (a: TurnView, b: TurnView) -> Bool {
        a.session == b.session && a.turn == b.turn && a.latest == b.latest && a.status == b.status && a.running == b.running && a.frozen == b.frozen && a.delivery == b.delivery
            && a.switched == b.switched && a.mark == b.mark && a.engine == b.engine && a.fileScope == b.fileScope
            && a.endSaid == b.endSaid && a.actions == b.actions && a.index == b.index && a.helper == b.helper && a.teamCard == b.teamCard
    }
    private var outcome: String { PhoneConversation.outcome(turn, latestStatus: status) }
    var body: some View {
        let blocks = PhoneConversation.blocks(turn, settled: !running)
        let folds = !running && PhoneConversation.workFolds(turn, outcome: outcome)
        VStack(alignment: .leading, spacing: 12) {
            if let words = PhoneConversation.divider(turn) { TimelineDivider(words: words, symbol: "eraser") }
            if let switched { TimelineDivider(words: switched, symbol: nil) }
            if let words = PhoneConversation.origin(turn) {
                Text(words).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).frame(maxWidth: .infinity, alignment: .trailing)
            }
            if let user = turn.user {
                if let teamCard { TeamResultsView(message: user, card: teamCard) } else { UserBubble(message: user, delivery: delivery, open: open) }
            }
            if !turn.replies.isEmpty || running {
                AuthorLine(mark: mark, engine: engine, model: PhoneConversation.turnModel(turn), helper: helper)
                    .contentShape(Rectangle()).onTapGesture { if !latest && !actions.isEmpty { withAnimation(.easeOut(duration: 0.15)) { tapped.toggle() } } }
            }
            if folds {
                Button { withAnimation(.easeOut(duration: 0.2)) { unfolded.toggle() } } label: {
                    HStack(spacing: 4) {
                        Text(PhoneConversation.foldWords(turn))
                        Image(systemName: unfolded ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold))
                    }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                }.buttonStyle(.plain)
            }
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .work(_, items):
                    if !folds || unfolded { VStack(alignment: .leading, spacing: 8) { ForEach(Array(items.enumerated()), id: \.offset) { _, item in WorkRow(item: item, frozen: frozen, person: helper != nil, open: open) } } }
                case let .prose(message):
                    VStack(alignment: .leading, spacing: 10) {
                        if !(message["text"].string ?? "").isEmpty { ReplyMarkdown(session: session, text: message["text"].string ?? "", streaming: running, open: open)
                            .environment(\.replyCitation, citation(for: message)).frame(maxWidth: .infinity, alignment: .leading) }
                        ReplyAttachments(message: message, open: open)
                    }
                case let .note(message) where message["steered"].bool:
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("已追加到本轮").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                        UserBubble(message: message, delivery: nil, open: open)
                    }.frame(maxWidth: .infinity, alignment: .trailing)
                case let .note(message):
                    Text(message["text"].string ?? "").font(PhoneTheme.caption).foregroundStyle(message["state"].string == "failed" ? PhoneTheme.red : PhoneTheme.muted)
                }
            }
            if !running { footer }
        }
    }
    private func citation(for message: NativeJSON) -> ReplyCitation? {
        guard !running, model.canRun, model.hasContentWindow, !model.currentSummary["archived"].bool, model.currentSummary["personal"] == .null, !model.detailCached, let row = message["id"].string else { return nil }
        let generation = model.generation, reading = model.contentGeneration
        return ReplyCitation { selected, block, offset in
            guard model.generation == generation, model.contentGeneration == reading, model.sessionId == session, model.canRun, model.hasContentWindow,
                  let current = model.detail["messages"].array.first(where: { $0["id"].string == row && $0["role"].string == "assistant" }),
                  let body = current["text"].string, body == message["text"].string,
                  let text = PhoneReplyQuote.create(session: session, message: row, selected: selected, body: body, block: block, blockOffset: offset) else { return }
            model.addToDraft(text + "\n\n", session: session)
        }
    }
    @ViewBuilder private var footer: some View {
        let outputs = turn.replies.flatMap { $0["outputs"].array }
        let summary = PhoneConversation.summary(turn, outputs: outputs, scope: fileScope)
        if !summary.files.isEmpty {
            ChangedFilesCard(summary: summary, partial: turn.replies.contains { $0["outputsTruncated"].bool || $0["outputsUnavailable"].bool }, open: open)
        }
        ForEach(outputs.filter { $0["change"].string == "created" && ["pptx", "pdf", "docx", "xlsx", "csv", "html", "image", "svg"].contains($0["kind"].string ?? "") }, id: \.path) { file in
            FileCard(file: file, open: open)
        }
        switch endSaid ? "completed" : outcome {
        case "failed": Text("失败").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red)
        case "stopped": Text(PhoneConversation.turnText(turn).isEmpty ? "已停止" : "已停止 · 保留了部分回复").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
        case "interrupted": Text("回复中断").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
        default: EmptyView()
        }
        if !actions.isEmpty && (latest || tapped) { TurnActionBar(actions: actions, index: index, turn: turn).padding(.leading, -8) }
    }
}

extension NativeJSON { var path: String { self["path"].string ?? "" } }

private struct UserBubble: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var original: PhoneReplyQuote?
    let message: NativeJSON
    let delivery: String?
    var open: ((String, String?) -> Void)? = nil
    /** A text rebuild's first message: the rebuilt conversation shown only when asked for. */
    @State private var unfolded = false
    var body: some View {
        let fold = PhoneHistory.fold(message)
        let all = PhoneAttachments.chips(message), pictures = all.filter(\.drawn), chips = all.filter { !$0.drawn }
        VStack(alignment: .trailing, spacing: 4) {
            if !pictures.isEmpty {
                MessagePictures(chips: pictures, alignment: .trailing) { chip in open?(chip.id, PreviewFiles.attachmentRoot) }
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            let text = fold?.rest ?? message["text"].string ?? ""
            if !text.isEmpty || fold != nil || !chips.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if let fold {
                        Button { withAnimation(.easeOut(duration: 0.2)) { unfolded.toggle() } } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "clock.arrow.circlepath").font(.system(size: 12))
                                Text(PhoneConversation.visible(fold.summary))
                                Image(systemName: unfolded ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold))
                            }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                        }.buttonStyle(.plain).accessibilityValue(unfolded ? "已展开" : "已折叠")
                        if unfolded { ConversationText(text: PhoneConversation.visible(fold.context), monospaced: true, size: 14) }
                    }
                    if !text.isEmpty || fold != nil { ConversationText(text: PhoneInputReferences(text).display) }
                    if text.contains("[引用回复 ") {
                        ForEach(PhoneReplyQuote.parse(text).filter { $0.session == model.sessionId }) { quote in
                            Button("查看引用原文") { original = quote }.font(PhoneTheme.caption)
                        }
                    }
                    if !chips.isEmpty {
                        VStack(alignment: .leading, spacing: 6) { ForEach(chips) { chip in SentAttachmentChip(chip: chip) { open?(chip.id, PreviewFiles.attachmentRoot) } } }
                    }
                }.padding(.horizontal, 14).padding(.vertical, 9)
                    .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 18))
                    .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in width * 0.86 }
            }
            let time = PhoneTime.parse(message["createdAt"]).map { PhoneTime.message($0) }
            let line = [time, delivery].compactMap { $0 }.joined(separator: " · ")
            if !line.isEmpty { Text(line).font(.system(size: 12)).foregroundStyle(PhoneTheme.faint) }
        }.frame(maxWidth: .infinity, alignment: .trailing)
        .sheet(item: $original) { OriginalReplyPassage(quote: $0) }
        .onChange(of: model.contentGeneration) { _, _ in original = nil }
    }
}

/** What an agent attached to its reply: its pictures drawn large, any other file a chip that previews what it can. */
private struct ReplyAttachments: View {
    let message: NativeJSON
    let open: (String, String?) -> Void
    var body: some View {
        let all = PhoneAttachments.chips(message), pictures = all.filter(\.drawn), chips = all.filter { !$0.drawn }
        if !pictures.isEmpty { MessagePictures(chips: pictures, output: true) { chip in open(chip.id, PreviewFiles.attachmentRoot) } }
        if !chips.isEmpty {
            VStack(alignment: .leading, spacing: 6) { ForEach(chips) { chip in SentAttachmentChip(chip: chip) { open(chip.id, PreviewFiles.attachmentRoot) } } }
        }
    }
}

/** The Harness, with the model secondary. */
private struct AuthorLine: View {
    let mark: String?
    let engine: String
    let model: String?
    let helper: PhoneAgentEntry?
    var body: some View {
        HStack(spacing: 8) {
            if let helper { AgentFace(avatar: helper.avatar, size: 16) }
            else { EngineTile(mark: mark, size: 16) }
            Text(helper?.name ?? engine).font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink)
            if helper == nil, let model { Text(model).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
        }
    }
}

private struct WorkRow: View {
    let item: PhoneWorkItem
    let frozen: Bool
    let person: Bool
    let open: (String, String?) -> Void
    @State private var expanded = false
    var body: some View {
        switch item {
        case let .thinking(message):
            row(icon: "brain", words: Text(thinkingWords(message)), detail: message["reasoning"].string, stat: nil, tail: nil, thought: true)
        case let .reads(messages):
            row(icon: "doc.text", words: Text("读取 \(messages.count) 个文件"), detail: nil, stat: nil, tail: nil, places: messages.flatMap { $0["tool"]["locations"].array.compactMap(\.string) })
        case let .tool(message):
            if case .object = message["subagent"] { SubagentRowView(message: message) } else { tool(message) }
        }
    }
    private func thinkingWords(_ message: NativeJSON) -> String {
        if person {
            if message["state"].string == "streaming" { return "在想" }
            if let ms = message["reasoningMs"].integer, ms > 0 { return "想了 \(max(1, Int((Double(ms) / 1000).rounded()))) 秒" }
            return "想法"
        }
        let spent = PhoneTime.duration(seconds: Double(message["reasoningMs"].integer ?? 0) / 1000)
        return spent.map { "思考了 " + $0 } ?? "思考"
    }
    @ViewBuilder private func tool(_ message: NativeJSON) -> some View {
        let label = PhoneConversation.toolLabel(message), state = message["state"].string, unrun = PhoneConversation.unrun(message)
        let verb = label.verb.map { Text($0 + " ") } ?? Text("")
        let object = label.mono ? Text(label.object).font(PhoneTheme.mono) : Text(label.object)
        let output = (message["tool"]["output"].string ?? message["text"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let diffs = message["tool"]["diffs"].array
        let judged = PhoneConversation.judgement(message), blocked = PhoneConversation.blocked(message)
        let tail: (String, Color)? = {
            if blocked != nil { return ("拦下", PhoneTheme.muted) }
            if let judged, judged.review, state == "completed" || state == "failed" { return (judged.words, PhoneTheme.muted) }
            if let unrun { return (unrun == "rejected" ? "已拒绝" : unrun == "expired" ? "已过期" : "已取消", PhoneTheme.muted) }
            if state == "failed" { return (PhoneConversation.failureReason(message), PhoneTheme.red) }
            if state == "cancelled" { return ("已停止", PhoneTheme.muted) }
            if let judged, state == "completed" { return (judged.words, PhoneTheme.muted) }
            return nil
        }()
        // A refused call says who stopped it and why above what it reported.
        let detail = [blocked?.line, diffs.isEmpty && !output.isEmpty ? output : nil].compactMap { $0 }.joined(separator: "\n\n")
        row(icon: icon(message), words: verb + object, detail: detail.isEmpty ? nil : detail, stat: blocked == nil ? PhoneConversation.diffStat(message["tool"]) : nil, tail: tail,
            running: state == "running" && !frozen, diff: blocked == nil ? diffs : [], open: blocked == nil && diffs.count == 1 ? diffs.first?["path"].string : nil, places: diffs.isEmpty ? message["tool"]["locations"].array.compactMap(\.string) : [])
    }
    private func icon(_ message: NativeJSON) -> String {
        if PhoneConversation.judgement(message)?.review == true { return "scale.3d" }
        if PhoneConversation.blocked(message) != nil { return "nosign" }
        return switch PhoneConversation.toolKind(message) {
        case "read": "doc.text"; case "edit": "square.and.pencil"; case "delete": "trash"; case "move": "arrow.right.doc.on.clipboard"
        case "search": "magnifyingglass"; case "execute": "terminal"; case "fetch": "globe"; default: "wrench"
        }
    }
    private func row(icon: String, words: Text, detail: String?, stat: PhoneDiffStat?, tail: (String, Color)?, running: Bool = false, diff: [NativeJSON] = [], open path: String? = nil, places: [String] = [], thought: Bool = false) -> some View {
        let expandable = !(detail ?? "").isEmpty || !diff.isEmpty || !places.isEmpty
        return VStack(alignment: .leading, spacing: 6) {
            Button { if expandable { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } } label: {
                HStack(spacing: 8) {
                    Group {
                        if running { ProgressView().controlSize(.mini).tint(PhoneTheme.accent) }
                        else { Image(systemName: icon).font(.system(size: 13)).foregroundStyle(PhoneTheme.muted) }
                    }.frame(width: 18)
                    words.font(.system(size: 14)).foregroundStyle(PhoneTheme.ink2).lineLimit(expanded ? nil : 1)
                    if let stat { DiffStatText(add: stat.add, del: stat.del) }
                    if expandable { Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(PhoneTheme.faint) }
                    Spacer(minLength: 0)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).allowsHitTesting(expandable)
            if let tail { Text(tail.0).font(PhoneTheme.caption).foregroundStyle(tail.1).lineLimit(2).padding(.leading, 26) }
            if expanded {
                ForEach(Array(places.enumerated()), id: \.offset) { _, place in
                    Button(place) { self.open(place, nil) }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink).underline().lineLimit(1).truncationMode(.head).padding(.leading, 26)
                }
                if !diff.isEmpty { ForEach(Array(diff.enumerated()), id: \.offset) { _, entry in DiffPreview(diff: entry) }.padding(.leading, 26)
                    if let path { Button("打开文件") { self.open(path, nil) }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink).underline().padding(.leading, 26) }
                } else if let detail, thought {
                    MarkdownView(text: String(detail.suffix(16_000)), size: 14, inert: true, ink: UIColor(PhoneTheme.ink2))
                        .padding(.leading, 26).frame(maxWidth: .infinity, alignment: .leading)
                } else if let detail {
                    ConversationText(text: String(detail.suffix(16_000)), monospaced: true, size: 14).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 10)).padding(.leading, 26)
                }
            }
        }
    }
}

/** A unified diff, never split: a phone has no room for two columns. */
struct DiffPreview: View {
    let diff: NativeJSON
    private static let limit = 400
    var body: some View {
        let lines = PhoneConversation.diffLines(old: diff["oldText"].string, new: diff["newText"].string ?? "").filter { $0.kind != .context }
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.prefix(Self.limit).enumerated()), id: \.offset) { _, line in
                Text((line.kind == .add ? "+ " : "- ") + line.text).font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(line.kind == .add ? PhoneTheme.green : PhoneTheme.red).frame(maxWidth: .infinity, alignment: .leading)
            }
            if lines.count > Self.limit { Text("还有 \(lines.count - Self.limit) 行").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).padding(.top, 4) }
        }.padding(10).background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct ChangedFilesCard: View {
    let summary: PhoneTurnSummary
    let partial: Bool
    let open: (String, String?) -> Void
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    Text("改动了 \(summary.files.count) 个文件").font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink)
                    DiffStatText(add: summary.add, del: summary.del)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(PhoneTheme.muted)
                    Spacer(minLength: 4)
                }.padding(.horizontal, 12).frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain)
            if partial { Text("可能还有没列出的文件").font(.system(size: 12)).foregroundStyle(PhoneTheme.amber).padding(.horizontal, 12).padding(.bottom, 8) }
            if expanded {
                Divider().overlay(PhoneTheme.line)
                ForEach(summary.files) { file in
                    Button { if !file.deleted { open(file.path, file.root) } } label: { FileRowLabel(file: file).padding(.horizontal, 12).padding(.vertical, 8).contentShape(Rectangle()) }
                        .buttonStyle(.plain).disabled(file.deleted)
                }
            }
        }
        .background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(PhoneTheme.line))
    }
}

/** A thin line across the column with its words in the middle: the session changed between two turns. */
private struct TimelineDivider: View {
    let words: String
    let symbol: String?
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(PhoneTheme.line).frame(height: 1)
            Group {
                if let symbol { Label(words, systemImage: symbol) } else { Text(words) }
            }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).fixedSize()
            Rectangle().fill(PhoneTheme.line).frame(height: 1)
        }.accessibilityElement(children: .combine)
    }
}

private struct FileCard: View {
    let file: NativeJSON
    let open: (String, String?) -> Void
    var body: some View {
        Button { open(file.path, file["root"].string) } label: {
            HStack(spacing: 10) {
                Image(systemName: "doc").foregroundStyle(PhoneTheme.muted)
                Text(file.path.split(separator: "/").last.map(String.init) ?? file.path).font(.system(size: 14)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                Spacer()
                Text("打开").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            }.padding(12).background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(PhoneTheme.line))
        }.buttonStyle(.plain)
    }
}
