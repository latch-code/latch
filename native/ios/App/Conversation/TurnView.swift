import LatchNativeCore
import SwiftUI

/** One prompt and its answer. Prose never folds; a turn's work folds away only once it has answered. */
struct TurnView: View, Equatable {
    let turn: PhoneTurn
    let latest: Bool
    let status: String?
    let running: Bool
    /** The Mac is out of reach, so nothing here may look as if it is still moving. */
    let frozen: Bool
    let delivery: String?
    let mark: String?
    let engine: String
    /** The run's own line says how it ended, so the footer does not say it twice. */
    let endSaid: Bool
    let open: (String, String?) -> Void
    @State private var unfolded = false
    nonisolated static func == (a: TurnView, b: TurnView) -> Bool {
        a.turn == b.turn && a.latest == b.latest && a.status == b.status && a.running == b.running && a.frozen == b.frozen && a.delivery == b.delivery
            && a.mark == b.mark && a.engine == b.engine && a.endSaid == b.endSaid
    }
    private var outcome: String { PhoneConversation.outcome(turn, latestStatus: status) }
    var body: some View {
        let blocks = PhoneConversation.blocks(turn, settled: !running)
        let folds = !running && PhoneConversation.workFolds(turn, outcome: outcome)
        VStack(alignment: .leading, spacing: 12) {
            if let user = turn.user { UserBubble(message: user, delivery: delivery) }
            if !turn.replies.isEmpty || running { AuthorLine(mark: mark, engine: engine, model: PhoneConversation.turnModel(turn)) }
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
                    if !folds || unfolded { VStack(alignment: .leading, spacing: 8) { ForEach(Array(items.enumerated()), id: \.offset) { _, item in WorkRow(item: item, frozen: frozen, open: open) } } }
                case let .prose(message): ConversationText(text: message["text"].string ?? "", markdown: true).frame(maxWidth: .infinity, alignment: .leading)
                case let .note(message):
                    Text(message["text"].string ?? "").font(PhoneTheme.caption).foregroundStyle(message["state"].string == "failed" ? PhoneTheme.red : PhoneTheme.muted)
                }
            }
            if !running { footer }
        }
    }
    @ViewBuilder private var footer: some View {
        let outputs = turn.replies.flatMap { $0["outputs"].array }
        let summary = PhoneConversation.summary(turn, outputs: outputs)
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
    }
}

extension NativeJSON { var path: String { self["path"].string ?? "" } }

private struct UserBubble: View {
    let message: NativeJSON
    let delivery: String?
    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            ConversationText(text: message["text"].string ?? "").padding(.horizontal, 14).padding(.vertical, 9)
                .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 18))
                .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in width * 0.86 }
            let time = PhoneTime.parse(message["createdAt"]).map { PhoneTime.message($0) }
            let line = [time, delivery].compactMap { $0 }.joined(separator: " · ")
            if !line.isEmpty { Text(line).font(.system(size: 12)).foregroundStyle(PhoneTheme.faint) }
        }.frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/** The Harness, with the model secondary. */
private struct AuthorLine: View {
    let mark: String?
    let engine: String
    let model: String?
    var body: some View {
        HStack(spacing: 8) {
            EngineTile(mark: mark, size: 16)
            Text(engine).font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink)
            if let model { Text(model).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
        }
    }
}

private struct WorkRow: View {
    let item: PhoneWorkItem
    let frozen: Bool
    let open: (String, String?) -> Void
    @State private var expanded = false
    var body: some View {
        switch item {
        case let .thinking(message):
            row(icon: "brain", words: Text(thinkingWords(message)), detail: message["reasoning"].string, stat: nil, tail: nil)
        case let .reads(messages):
            row(icon: "doc.text", words: Text("读取 \(messages.count) 个文件"), detail: nil, stat: nil, tail: nil, places: messages.flatMap { $0["tool"]["locations"].array.compactMap(\.string) })
        case let .tool(message): tool(message)
        }
    }
    private func thinkingWords(_ message: NativeJSON) -> String {
        let spent = PhoneTime.duration(seconds: Double(message["reasoningMs"].integer ?? 0) / 1000)
        return spent.map { "思考了 " + $0 } ?? "思考"
    }
    @ViewBuilder private func tool(_ message: NativeJSON) -> some View {
        let label = PhoneConversation.toolLabel(message), state = message["state"].string, unrun = PhoneConversation.unrun(message)
        let verb = label.verb.map { Text($0 + " ") } ?? Text("")
        let object = label.mono ? Text(label.object).font(PhoneTheme.mono) : Text(label.object)
        let output = (message["tool"]["output"].string ?? message["text"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let diffs = message["tool"]["diffs"].array
        let tail: (String, Color)? = {
            if let unrun { return (unrun == "rejected" ? "已拒绝" : unrun == "expired" ? "已过期" : "已取消", PhoneTheme.muted) }
            if state == "failed" { return (PhoneConversation.failureReason(message), PhoneTheme.red) }
            if state == "cancelled" { return ("已停止", PhoneTheme.muted) }
            return nil
        }()
        row(icon: icon(message), words: verb + object, detail: diffs.isEmpty ? (output.isEmpty ? nil : output) : nil, stat: PhoneConversation.diffStat(message["tool"]), tail: tail,
            running: state == "running" && !frozen, diff: diffs, open: diffs.count == 1 ? diffs.first?["path"].string : nil, places: diffs.isEmpty ? message["tool"]["locations"].array.compactMap(\.string) : [])
    }
    private func icon(_ message: NativeJSON) -> String {
        switch PhoneConversation.toolKind(message) {
        case "read": "doc.text"; case "edit": "square.and.pencil"; case "delete": "trash"; case "move": "arrow.right.doc.on.clipboard"
        case "search": "magnifyingglass"; case "execute": "terminal"; case "fetch": "globe"; default: "wrench"
        }
    }
    private func row(icon: String, words: Text, detail: String?, stat: PhoneDiffStat?, tail: (String, Color)?, running: Bool = false, diff: [NativeJSON] = [], open path: String? = nil, places: [String] = []) -> some View {
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
                ForEach(summary.files, id: \.path) { file in
                    Button { if !file.deleted { open(file.path, file.root) } } label: { FileRowLabel(file: file).padding(.horizontal, 12).padding(.vertical, 8).contentShape(Rectangle()) }
                        .buttonStyle(.plain).disabled(file.deleted)
                }
            }
        }
        .background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(PhoneTheme.line))
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
