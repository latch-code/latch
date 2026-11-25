import Foundation
import LatchNativeCore

func phoneFileMentionTokensFixture(_ data: Data) throws -> [String: Any] {
    let cases = try NativeJSON.decode(data)
    guard let path = cases["path"].string else { throw NativeFailure.invalidRecord }
    let edits: [Any] = try cases["drafts"].array.map { item in
        guard let draft = item["text"].string else { throw NativeFailure.invalidRecord }
        let current = item["current"].string ?? draft
        let selection = NSRange(location: item["caret"].integer.map(Int.init) ?? draft.utf16.count,
                                length: item["length"].integer.map(Int.init) ?? 0)
        let previous = item["previous"].string.flatMap {
            PhoneFileMentionToken.active(in: $0, selection: NSRange(location: $0.utf16.count, length: 0))
        }
        guard let token = PhoneFileMentionToken.active(in: draft, selection: selection, continuing: previous) else { return NSNull() }
        let edit = token.inserting(root: "default", path: path, in: current, selection: selection)
        return ["query": token.query, "text": edit.map { $0.text as Any } ?? NSNull(),
                "caret": edit.map { $0.selection.location as Any } ?? NSNull()] as [String: Any]
    }
    let retained = try cases["markers"].array.map { item in
        guard let marker = item.string else { throw NativeFailure.invalidRecord }
        return PhoneFileMentionToken.contains(root: "default", path: path, in: marker)
    }
    // In the editor each chip is one character. The two UTF-16 units of the emoji stay ordinary text.
    let offsets = PhoneMentionOffsets(ranges: [NSRange(location: 3, length: 5), NSRange(location: 13, length: 16)])
    let file = offsets.sourceRange(for: NSRange(location: 9, length: 1))
    let both = offsets.sourceRange(for: NSRange(location: 3, length: 7))
    let middleOfFile = offsets.displayRange(for: NSRange(location: 21, length: 0))
    let visible = try cases["spacing"].array.map { item -> String in
        guard let draft = item.string else { throw NativeFailure.invalidRecord }
        let markers = PhoneFileMentionToken.ranges(marker: "@a", in: draft)
        let projected = NSMutableString(string: draft)
        for span in PhoneMentionOffsets(markers: markers, in: draft).ranges.reversed() {
            projected.replaceCharacters(in: span, with: "■")
        }
        return projected as String
    }
    return ["edits": edits, "retained": retained, "visible": visible,
            "selection": [[file.location, file.length], [both.location, both.length], [middleOfFile.location, middleOfFile.length]]]
}

func phoneMentionRecipientsFixture(_ data: Data) throws -> [String: Any] {
    let input = try NativeJSON.decode(data), snapshot = input["snapshot"]
    if let item = PhoneWorkItemSummary(input["item"]) {
        let rows = PhoneWorkPostChoice.choices(snapshot: snapshot, item: item)
        let matches = PhoneWorkPostChoice.matching(rows, query: input["query"].string ?? "").map(\.label)
        let text = "　@查 后面的正文", selection = NSRange(location: 3, length: 0)
        let edit = PhoneFileMentionToken.active(in: text, selection: selection)?.removing(in: text, selection: selection)
        return ["rows": rows.map { [$0.label, $0.disabled] }, "matches": matches, "text": edit?.text ?? "", "caret": edit?.selection.location ?? -1]
    }
    guard let team = PhoneMemberMentions(snapshot: snapshot, session: "lead") else { return [:] }
    let rounds: [Any] = try input["drafts"].array.map { item in
        let files = item["fileRefs"] == .null ? [] : try PhoneFileMatches(item["fileRefs"], forMentions: true).files
        guard let round = team.round(in: item["text"].string ?? "", hasMaterials: item["materials"].bool, fileRefs: files) else { return NSNull() }
        return ["ids": round.itemIds, "prompt": round.prompt, "reason": round.reason as Any] as [String: Any]
    }
    return ["team": team.teamId, "rows": team.members.map { [$0.token, $0.disabled] }, "rounds": rounds,
            "matches": team.matching(input["query"].string ?? "").map(\.id)]
}
