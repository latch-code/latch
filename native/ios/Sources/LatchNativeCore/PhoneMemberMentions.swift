import Foundation

/** The newest team of a lead session. Members are eligible independently of permission to read project files. */
public struct PhoneMemberMentions: Equatable, Sendable {
    public struct Member: Equatable, Identifiable, Sendable {
        public let id: String
        public let token: String
        public let name: String
        public let title: String
        public let state: String
        public let harnessId: String
        public let disabled: String?
    }
    public struct Round: Equatable, Sendable {
        public let teamId: String
        public let itemIds: [String]
        public let prompt: String
        public let reason: String?
    }
    public let teamId: String
    public let members: [Member]

    public init?(snapshot: NativeJSON, session: String) {
        guard snapshot["catalog"]["features"]["teams"].bool, snapshot["device"]["scopes"].array.contains(.string("run")),
              PhoneSessions.mayReadBody(snapshot: snapshot, sessionId: session),
              let team = PhoneTeamGraph.teams(snapshot["teams"].array, session: session).last,
              let id = team["id"].string, case let .array(rows) = team["members"], rows.count <= 8 else { return nil }
        teamId = id
        let tasks = snapshot["tasks"].array
        let roundOpen = !["returned", "kept"].contains(team["state"].string)
        var used = Set<Data>(), listed = [Member]()
        for row in rows {
            guard let itemId = row["itemId"].string, let title = row["title"].string,
                  let harness = row["harnessId"].string, let state = row["state"].string else { return nil }
            let name = row["name"].string.flatMap { $0.isEmpty ? nil : $0 } ?? title
            let words = name.unicodeScalars.split { phonePromptWhitespace(UInt16(clamping: $0.value)) }.map(String.init)
            let short = words.joined(separator: "-").unicodeScalars.prefix(24)
            let base = "@" + (short.isEmpty ? "member" : String(short))
            var token = base, number = 1
            while !used.insert(Data(token.utf8)).inserted {
                number += 1; token = base + "-" + String(number)
            }
            let disabled: String?
            if let sessionId = row["sessionId"].string {
                let task = tasks.first { $0["id"].string == sessionId }
                if task == nil || task?["archived"].bool == true { disabled = "会话已归档" }
                else if PhoneTeamGraph.atWork(state) || ["running", "waiting-approval"].contains(task?["status"].string) { disabled = "还在做上一件" }
                else { disabled = roundOpen ? "这一轮还没结束" : nil }
            } else { disabled = "没有开始过" }
            listed.append(Member(id: itemId, token: token, name: name, title: title, state: state, harnessId: harness, disabled: disabled))
        }
        members = listed
    }

    public func matching(_ query: String) -> [Member] {
        let needle = phonePromptTrim(query).lowercased(with: .current)
        guard !needle.isEmpty else { return members }
        return members.filter { member in
            [member.name, member.title, String(member.token.dropFirst())].contains {
                $0.lowercased(with: .current).range(of: needle, options: .literal) != nil
            }
        }
    }

    public func round(in text: String, hasMaterials: Bool = false, fileRefs: [PhoneFileMatches.Hit] = []) -> Round? {
        let materials = PhoneInputReferences.materialRanges(in: text)
        let excluded = materials + fileRefs.flatMap { PhoneFileMentionToken.ranges(marker: "@\($0.root):\($0.path)", in: text, excluding: materials) }
        let marks = members.flatMap { member in
            PhoneFileMentionToken.ranges(marker: member.token, in: text, excluding: excluded).map { (member.id, $0) }
        }.sorted { $0.1.location < $1.1.location }
        guard !marks.isEmpty else { return nil }
        var ids = [String]()
        for (id, _) in marks where !ids.contains(id) { ids.append(id) }
        // Only remove the addressed mentions. Preserve whitespace, output and identifiers inside every source.
        let source = text as NSString
        var cursor = 0, prompt = "", plain = ""
        let pieces = (marks.map { (range: $0.1, material: false) } + materials.map { (range: $0, material: true) })
            .sorted { $0.range.location < $1.range.location }
        for piece in pieces {
            plain += source.substring(with: NSRange(location: cursor, length: piece.range.location - cursor))
            if piece.material {
                prompt += plain.replacingOccurrences(of: "[ \t]{2,}", with: " ", options: .regularExpression) + source.substring(with: piece.range)
                plain = ""
            }
            cursor = NSMaxRange(piece.range)
        }
        plain += source.substring(from: cursor)
        prompt = phonePromptTrim(prompt + plain.replacingOccurrences(of: "[ \t]{2,}", with: " ", options: .regularExpression))
        let reason: String?
        if hasMaterials { reason = "派给成员只带文字" }
        else if let busy = members.first(where: { ids.contains($0.id) && $0.disabled != nil }), let refusal = busy.disabled {
            reason = "\(busy.title) · \(refusal)"
        } else if prompt.isEmpty { reason = "写下要成员做的事" }
        else { reason = prompt.utf16.count > 4000 ? "最多 4,000 个字符" : nil }
        return Round(teamId: teamId, itemIds: ids, prompt: prompt, reason: reason)
    }
}
