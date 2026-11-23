import LatchNativeCore
import SwiftUI

/** Visible, settled replies can turn an inline code path into a file the current Host recognizes. */
struct ReplyMarkdown: View {
    @EnvironmentObject private var model: PhoneModel
    let session: String
    let text: String
    let streaming: Bool
    let open: (String, String?) -> Void
    @State private var resolved: (lookup: Lookup, names: Set<Data>)?

    private struct Lookup: Equatable {
        let context: SessionFilesContext
        let dataScope: String?
        let text: String
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.context == rhs.context && lhs.dataScope == rhs.dataScope && lhs.text.utf8.elementsEqual(rhs.text.utf8)
        }
    }

    private var lookup: Lookup? {
        guard !streaming, model.sessionId == session, model.currentFileAccess != nil, model.privateSnapshot.confirmed,
              !model.detailCached, PhoneWorkItems.canReadFiles(model.snapshot),
              PhoneSessions.mayReadBody(snapshot: model.snapshot, sessionId: session), text.utf8.contains(0x60) else { return nil }
        return Lookup(context: model.filesContext(session), dataScope: model.snapshot["device"]["dataScope"].string, text: text)
    }

    var body: some View {
        let key = lookup
        MarkdownView(text: text, streaming: streaming, open: open, knownFiles: resolved?.lookup == key ? resolved?.names ?? [] : [])
            .task(id: key) {
                guard let key, let workspace = model.workspace, let access = model.currentFileAccess else { resolved = nil; return }
                let parse: MarkdownCache.Parse
                if let cached = MarkdownCache.lookup(text) { parse = cached } else { parse = await MarkdownCache.parse(text) }
                guard !Task.isCancelled, let blocks = parse.blocks else { return }
                let candidates = Self.candidates(in: blocks)
                var names = Set<Data>()
                do {
                    for start in stride(from: 0, to: candidates.count, by: 64) {
                        try Task.checkCancellation()
                        let batch = Array(candidates[start..<min(start + 64, candidates.count)])
                        let confirmed = try await workspace.knownFileReferences(sessionId: session, references: batch, access: access)
                        names.formUnion(confirmed.map { Data($0.utf8) })
                    }
                    try Task.checkCancellation()
                    guard lookup == key, model.currentFileAccess?.lease.sameWindow(as: access.lease) == true else { return }
                    resolved = (key, names)
                } catch {
                    if !Task.isCancelled, lookup == key { resolved = nil }
                }
            }
    }

    private static func candidates(in blocks: [PhoneRichBlock]) -> [String] {
        var paths: [String] = [], seen = Set<Data>()
        func collect(_ value: AttributedString) {
            for run in value.runs {
                guard paths.count < 512 else { return }
                guard run.link == nil, run.imageURL == nil, run.inlinePresentationIntent?.contains(.code) == true,
                      let path = PhoneRichText.codeFileCandidate(String(value[run.range].characters)),
                      seen.insert(Data(path.utf8)).inserted else { continue }
                paths.append(path)
            }
        }
        for block in blocks {
            if paths.count == 512 { break }
            switch block {
            case let .text(line): collect(line.content)
            case let .table(table):
                for cell in table.header { collect(cell) }
                for row in table.rows { for cell in row { collect(cell) } }
            default: break
            }
        }
        return paths
    }
}
