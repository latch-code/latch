import Foundation

/**
 * What this device has looked at, as the web keeps it (`sessions.ts`): a session is new when the Host moved it past what
 * was seen, or past the moment this record began. Kept in the computer's own encrypted vault, never on the Host.
 */
public struct PhoneSeen: Codable, Equatable, Sendable {
    public var baseline: String
    public var seen: [String: String]
    public static let limit = 400
    public init(baseline: String, seen: [String: String] = [:]) { self.baseline = baseline; self.seen = seen }
    public static func fresh(now: Date = Date()) -> PhoneSeen {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return PhoneSeen(baseline: formatter.string(from: now))
    }
    public func unread(_ task: NativeJSON) -> Bool {
        guard let id = task["id"].string, let updated = PhoneTime.parse(task["updatedAt"]),
              let seen = PhoneTime.parse(.string(seen[id] ?? baseline)) else { return false }
        return updated > seen
    }
    /** Nil when nothing changes, so the vault is written only when it must be. */
    public func marking(_ id: String, updatedAt: String) -> PhoneSeen? {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}"), PhoneTime.parse(.string(updatedAt)) != nil else { return nil }
        if let previous = seen[id].flatMap({ PhoneTime.parse(.string($0)) }), let next = PhoneTime.parse(.string(updatedAt)), previous >= next { return nil }
        var next = self; next.seen[id] = updatedAt
        if next.seen.count > Self.limit {
            let oldest = next.seen.sorted { (PhoneTime.parse(.string($0.value)) ?? .distantPast) < (PhoneTime.parse(.string($1.value)) ?? .distantPast) }
            for (key, _) in oldest.prefix(next.seen.count - Self.limit) { next.seen.removeValue(forKey: key) }
        }
        return next
    }
    /** Forgets sessions the Host no longer lists. */
    public func pruned(_ tasks: [NativeJSON]) -> PhoneSeen? {
        let ids = Set(tasks.compactMap { $0["id"].string })
        let kept = seen.filter { ids.contains($0.key) }
        return kept.count == seen.count ? nil : PhoneSeen(baseline: baseline, seen: kept)
    }
    public static func decode(_ data: Data) -> PhoneSeen? {
        guard let value = try? JSONDecoder().decode(PhoneSeen.self, from: data), PhoneTime.parse(.string(value.baseline)) != nil,
              value.seen.count <= limit, value.seen.allSatisfy({ LinkBytes.matches($0.key, "[A-Za-z0-9_-]{1,160}") && $0.value.utf8.count <= 40 }) else { return nil }
        return value
    }
}

/** A line of a file's diff as the Host numbers it. */
public struct PhoneReviewLine: Equatable, Sendable, Hashable {
    public enum Kind: String, Sendable { case context, add, remove }
    public let kind: Kind
    public let text: String
    public let oldLine: Int?
    public let newLine: Int?
    public let byCommand: Bool
    public init(kind: Kind, text: String, oldLine: Int?, newLine: Int?, byCommand: Bool = false) {
        self.kind = kind; self.text = text; self.oldLine = oldLine; self.newLine = newLine; self.byCommand = byCommand
    }
    public init?(_ value: NativeJSON) {
        guard let raw = value["kind"].string, let kind = Kind(rawValue: raw) else { return nil }
        self.init(kind: kind, text: String((value["text"].string ?? "").prefix(20_000)), oldLine: value["oldLine"].integer.map { Int(clamping: $0) },
            newLine: value["newLine"].integer.map { Int(clamping: $0) }, byCommand: value["byCommand"].bool)
    }
    /** `new` for added and unchanged lines, `old` for removed ones. */
    public var side: PhoneNoteSide { kind == .remove ? .old : .new }
    public func number(on side: PhoneNoteSide) -> Int? {
        side == .new ? (kind == .remove ? nil : newLine) : (kind == .add ? nil : oldLine)
    }
}

public enum PhoneNoteSide: String, Sendable, Codable { case old, new }

/** Lines picked in one file's diff, on one side; `anchor` is where the pick began. */
public struct PhoneLineSelection: Equatable, Sendable {
    public let side: PhoneNoteSide
    public let start: Int
    public let end: Int
    public let anchor: Int
    public init(side: PhoneNoteSide, start: Int, end: Int, anchor: Int) { self.side = side; self.start = start; self.end = end; self.anchor = anchor }
    public func contains(_ line: PhoneReviewLine) -> Bool { line.number(on: side).map { $0 >= start && $0 <= end } ?? false }
    /** 「第 42–45 行」, or 「第 18 行」. */
    public var label: String { PhoneReview.linesLabel(start: start, end: end) }
}

/** One note as the Host keeps it. */
public struct PhoneReviewNote: Equatable, Sendable, Identifiable {
    public enum Status: String, Sendable { case pending, sent, claimed = "agent-claimed", reviewed }
    public let id: String
    public let root: String
    public let path: String
    public let start: Int
    public let end: Int
    public let side: PhoneNoteSide
    public let lines: [String]
    public let text: String
    public let status: Status
    public let sending: Bool
    public let queued: Bool
    public init?(_ value: NativeJSON) {
        guard let id = value["id"].string, LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}"), let root = value["root"].string, let path = value["path"].string,
              let start = value["range"]["start"].integer, let end = value["range"]["end"].integer, start >= 1, end >= start,
              let side = value["side"].string.flatMap(PhoneNoteSide.init(rawValue:)), let status = value["status"].string.flatMap(Status.init(rawValue:)) else { return nil }
        self.id = id; self.root = root; self.path = path; self.start = Int(clamping: start); self.end = Int(clamping: end); self.side = side
        lines = value["anchor"]["lines"].array.prefix(PhoneReview.lineLimit).compactMap(\.string)
        text = String((value["text"].string ?? "").prefix(4000)); self.status = status
        sending = value["sending"].bool; queued = value["queueId"].string != nil
    }
    /** The card's state word, as the web's. */
    public var word: String {
        if status == .pending && queued { return "已排队" }
        if status == .pending && sending { return "发送中" }
        switch status { case .pending: return "待发"; case .sent: return "已发送"; case .claimed: return "Agent 称已修"; case .reviewed: return "你已复核" }
    }
    public var canEdit: Bool { status == .pending && !sending }
    public func same(root: String, path: String) -> Bool { self.root == root && self.path == path }
}

/** The send a Host holds open without a queued item: its answer never came. */
public struct PhoneOpenSend: Equatable, Sendable {
    public let id: String
    public let noteIds: [String]
}

public enum PhoneNoteLocation: Equatable, Sendable { case exact(Int, Int), moved(Int, Int), stale }

/** Where one file's notes go in its diff: under the last line of their place, or apart as stale. */
public struct PhonePlacedNotes: Equatable, Sendable {
    /** By `side:line` of the line each note sits under. */
    public var under: [String: [PhoneReviewNote]] = [:]
    public var stale: [PhoneReviewNote] = []
    public var located: [String: (start: Int, end: Int)] = [:]
    public static func == (a: Self, b: Self) -> Bool {
        a.under == b.under && a.stale == b.stale && a.located.mapValues { [$0.start, $0.end] } == b.located.mapValues { [$0.start, $0.end] }
    }
    public func notes(under line: PhoneReviewLine) -> [PhoneReviewNote] {
        (line.number(on: .new).map { under["new:\($0)"] ?? [] } ?? []) + (line.number(on: .old).map { under["old:\($0)"] ?? [] } ?? [])
    }
    public func noted(_ line: PhoneReviewLine, notes: [PhoneReviewNote]) -> Bool {
        notes.contains { note in
            guard let at = located[note.id], let number = line.number(on: note.side) else { return false }
            return number >= at.start && number <= at.end
        }
    }
}

/** What the bottom bar tallies, from the Host's notes (`noteTally`). */
public struct PhoneNoteTally: Equatable, Sendable {
    public let ready: [String]
    public let sending: Int
    public let queued: Int
    public let sent: Int
    public let toReview: Int
    public init(ready: [String], sending: Int, queued: Int, sent: Int, toReview: Int) {
        self.ready = ready; self.sending = sending; self.queued = queued; self.sent = sent; self.toReview = toReview
    }
}

/** The review page's bottom bar: the one thing to do next. */
public enum PhoneFootAction: Equatable, Sendable {
    case note(label: String)
    case unknown(sending: Int)
    case send(label: String, count: Int, disabled: Bool)
    case deliver(status: String?, running: Bool)
    case none(status: String?, running: Bool)
}

/** One run of the diff the page draws: lines in view, or unchanged lines folded away. */
public enum PhoneDiffSegment: Equatable, Sendable {
    case lines([PhoneReviewLine])
    case gap([PhoneReviewLine])
}

public enum PhoneReviewScope: String, Sendable, CaseIterable {
    case turn, session, uncommitted
    public var label: String { switch self { case .turn: "本轮"; case .session: "这个会话"; case .uncommitted: "未提交" } }
}

/**
 * The phone's way from the session list to a turn's changes and back, as the web's `phone-review`: which rows offer
 * 「复核 N 处改动」, the taps that pick lines, where kept notes sit, and the one action of the bottom bar.
 */
public enum PhoneReview {
    /** The Host's limits (`REVIEW_NOTE_LIMITS`). */
    public static let lineLimit = 100
    public static let lineChars = 1000
    public static let textChars = 4000
    public static let perSend = 50
    /** At most this many sessions have their turns read for the list. */
    public static let candidates = 8
    static let active: Set<String> = ["running", "waiting-approval"]

    public static func linesLabel(start: Int, end: Int) -> String { start == end ? "第 \(start) 行" : "第 \(start)–\(end) 行" }

    /** A session whose files the review can show: an Agent session the Host still runs, not a chat. */
    public static func reviewable(_ task: NativeJSON) -> Bool {
        task["mode"].string != "chat" && task["personal"] == .null && !task["archived"].bool && !active.contains(task["status"].string ?? "")
    }
    private static func waiting(_ counts: NativeJSON) -> (pending: UInt64, toReview: UInt64) {
        (counts["pending"].integer ?? 0, (counts["sent"].integer ?? 0) + (counts["claimed"].integer ?? 0))
    }
    public static func counts(_ snapshot: NativeJSON, _ id: String) -> NativeJSON {
        snapshot["reviewNotes"].array.first { $0["sessionId"].string == id } ?? .null
    }
    /** The sessions worth asking the Host about their turns: settled, with something new or notes still waiting. Newest first. */
    public static func candidates(_ snapshot: NativeJSON, unread: (NativeJSON) -> Bool) -> [NativeJSON] {
        guard snapshot["catalog"]["features"]["changes"].bool else { return [] }
        return snapshot["tasks"].array.filter { task in
            let notes = waiting(counts(snapshot, task["id"].string ?? ""))
            return reviewable(task) && (unread(task) || notes.pending > 0 || notes.toReview > 0)
        }.sorted { (PhoneTime.parse($0["updatedAt"]) ?? .distantPast) > (PhoneTime.parse($1["updatedAt"]) ?? .distantPast) }.prefix(candidates).map { $0 }
    }
    /** Whether this device reads turn records for the list at all: the Host has them and the data scope covers files. */
    public static func readsTurns(_ snapshot: NativeJSON) -> Bool {
        snapshot["catalog"]["features"]["changes"].bool && snapshot["device"]["dataScope"].string == "all"
    }
    /**
     * 「复核 N 处改动」 when the latest turn changed N files this device has not looked at, or 「复核改动」 when notes wait on
     * the person and no count can be read. `turns`: the Host's records; nil when this device cannot read them.
     */
    public static func shortcut(_ task: NativeJSON, unread: Bool, turns: [NativeJSON]?, counts: NativeJSON) -> String? {
        guard reviewable(task) else { return nil }
        let latest = turns?.last
        let files = latest.map { $0["state"].string != "running" && !$0["undone"].bool ? Int(clamping: $0["files"].integer ?? 0) : 0 } ?? 0
        let notes = waiting(counts)
        if !(unread && files > 0) && notes.pending == 0 && notes.toReview == 0 { return nil }
        return files > 0 ? "复核 \(files) 处改动" : "复核改动"
    }

    // MARK: lines

    /** A press on a line: a fresh pick of it, or with `extend` the stretch from where the pick began, at most 100 lines. */
    public static func select(_ current: PhoneLineSelection?, _ line: PhoneReviewLine, extend: Bool) -> PhoneLineSelection? {
        func fresh() -> PhoneLineSelection? { line.number(on: line.side).map { PhoneLineSelection(side: line.side, start: $0, end: $0, anchor: $0) } }
        guard extend, let current, let number = line.number(on: current.side) else { return fresh() }
        let reach = lineLimit - 1
        let to = max(current.anchor - reach, min(current.anchor + reach, number))
        return PhoneLineSelection(side: current.side, start: min(current.anchor, to), end: max(current.anchor, to), anchor: current.anchor)
    }
    /** The phone's tap: the first picks, the next stretches, and tapping the only picked line again lets it go. */
    public static func tap(_ current: PhoneLineSelection?, _ line: PhoneReviewLine) -> PhoneLineSelection? {
        if let current, current.start == current.end, line.number(on: current.side) == current.start, line.side == current.side { return nil }
        return select(current, line, extend: current != nil)
    }
    /** The file one step away, or none past either end. */
    public static func step(_ index: Int, count: Int, by: Int) -> Int? {
        let next = index + by
        return next >= 0 && next < count ? next : nil
    }
    /** A line as notes keep and compare it: cut to 1000 UTF-16 units, as the Host counts. */
    public static func cut(_ line: String) -> String {
        let units = Array(line.utf16)
        return units.count > lineChars ? String(decoding: units[0..<lineChars], as: UTF16.self) : line
    }
    public static func snippet(_ lines: [String], _ selection: PhoneLineSelection) -> [String] {
        guard selection.start >= 1, selection.start <= lines.count else { return [] }
        return lines[(selection.start - 1)..<min(lines.count, selection.end)].map(cut)
    }
    /**
     * Where a note's lines are now (`locateNote`): the same place, else the nearest exact copy within 200 lines, else
     * stale; two copies equally near or a snippet too thin to tell apart is stale too.
     */
    public static func locate(start: Int, end: Int, lines: [String], current: [String], window: Int = 200) -> PhoneNoteLocation {
        guard !lines.isEmpty else { return .stale }
        let span = end - start
        func at(_ index: Int) -> Bool {
            index >= 0 && index + lines.count <= current.count && lines.indices.allSatisfy { cut(current[index + $0]) == lines[$0] }
        }
        let origin = start - 1
        if at(origin) { return .exact(start, end) }
        let body = lines.joined().filter { !$0.isWhitespace }
        // JS counts UTF-16 units here too.
        if body.utf16.count < (lines.count == 1 ? 20 : 8) { return .stale }
        for distance in 1...max(1, window) {
            let before = at(origin - distance), after = at(origin + distance)
            if before && after { return .stale }
            if before || after {
                let first = (before ? origin - distance : origin + distance) + 1
                return .moved(first, first + span)
            }
        }
        return .stale
    }
    /** A side's text as lines, without the empty one after a final line break. */
    public static func textLines(_ lines: [PhoneReviewLine], side: PhoneNoteSide) -> [String] {
        lines.filter { side == .new ? $0.kind != .remove : $0.kind != .add }.map(\.text)
    }
    public static func place(_ notes: [PhoneReviewNote], old: [String], new: [String]) -> PhonePlacedNotes {
        var placed = PhonePlacedNotes()
        for note in notes {
            switch locate(start: note.start, end: note.end, lines: note.lines, current: note.side == .old ? old : new) {
            case .stale: placed.stale.append(note)
            case let .exact(start, end), let .moved(start, end):
                placed.located[note.id] = (start, end)
                placed.under["\(note.side.rawValue):\(end)", default: []].append(note)
            }
        }
        return placed
    }
    /**
     * The whole-file hunks as the page draws them: changes with three lines around each, the rest folded. `keep` holds
     * unchanged lines in view like a change: those a note is on, and the ones picked.
     */
    public static func segments(_ lines: [PhoneReviewLine], keep: (PhoneReviewLine) -> Bool = { _ in false }) -> [PhoneDiffSegment] {
        var near = Array(repeating: false, count: lines.count)
        for (index, line) in lines.enumerated() where line.kind != .context || keep(line) {
            for at in max(0, index - 3)...min(lines.count - 1, index + 3) { near[at] = true }
        }
        var result: [PhoneDiffSegment] = [], index = 0
        while index < lines.count {
            let start = index, shown = near[index]
            while index < lines.count && near[index] == shown { index += 1 }
            let part = Array(lines[start..<index])
            result.append(shown ? .lines(part) : .gap(part))
        }
        return result
    }
    public static func lines(_ detail: NativeJSON) -> [PhoneReviewLine] {
        detail["hunks"].array.prefix(10_000).flatMap { $0["lines"].array.compactMap(PhoneReviewLine.init) }
    }

    // MARK: notes and the bottom bar

    public static func notes(_ list: NativeJSON) -> [PhoneReviewNote] { list["notes"].array.prefix(200).compactMap(PhoneReviewNote.init) }
    /** The open send a person can retry or give up: one the Host holds without a queued item. */
    public static func openSend(_ list: NativeJSON) -> PhoneOpenSend? {
        guard let send = list["openSends"].array.first(where: { $0["queueId"] == .null }), let id = send["id"].string,
              LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}") else { return nil }
        return PhoneOpenSend(id: id, noteIds: send["noteIds"].array.compactMap(\.string))
    }
    public static func tally(_ notes: [PhoneReviewNote]) -> PhoneNoteTally {
        let pending = notes.filter { $0.status == .pending }
        return PhoneNoteTally(ready: pending.filter { !$0.sending }.map(\.id), sending: pending.filter { $0.sending && !$0.queued }.count,
            queued: pending.filter(\.queued).count, sent: notes.filter { $0.status == .sent }.count,
            toReview: notes.filter { $0.status == .sent || $0.status == .claimed }.count)
    }
    public static func foot(tally: PhoneNoteTally, selection: PhoneLineSelection?, running: Bool, canQueue: Bool, offline: Bool,
        unknownSend: Bool, canWrite: Bool, canDeliver: Bool) -> PhoneFootAction {
        if let selection, canWrite { return .note(label: selection.label) }
        if unknownSend && canWrite { return .unknown(sending: tally.sending) }
        if !tally.ready.isEmpty && canWrite {
            let label = running ? (canQueue ? "排到下一轮" : "本轮结束后发") : "发给 Agent (\(tally.ready.count))"
            return .send(label: label, count: tally.ready.count, disabled: offline || (running && !canQueue))
        }
        let status: (String, Bool)? = tally.sending > 0 ? ("正在发送 \(tally.sending) 条反馈", true)
            : running && tally.sent > 0 ? ("Agent 在修订 \(tally.sent) 条反馈", true)
            : tally.queued > 0 ? ("\(tally.queued) 条反馈已排队", false)
            : tally.toReview > 0 ? ("\(tally.toReview) 条待你复核", false) : nil
        return canDeliver ? .deliver(status: status?.0, running: status?.1 ?? false) : .none(status: status?.0, running: status?.1 ?? false)
    }

    // MARK: files

    /** Folders first at every level, then names, as the web's tree and diff read. */
    public static func compare(_ a: NativeJSON, _ b: NativeJSON) -> Bool {
        let rootA = a["root"].string ?? "", rootB = b["root"].string ?? ""
        // The web's `localeCompare`: letters before case, so `a.ts` comes before `README.md`.
        func less(_ a: String, _ b: String) -> Bool { a.compare(b, options: [], range: nil, locale: Locale(identifier: "en")) == .orderedAscending }
        if rootA != rootB { return less(rootA, rootB) }
        let left = (a["path"].string ?? "").split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let right = (b["path"].string ?? "").split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        for index in 0..<min(left.count, right.count) {
            let folderLeft = index < left.count - 1, folderRight = index < right.count - 1
            if folderLeft != folderRight { return folderLeft }
            if left[index] != right[index] { return less(left[index], right[index]) }
        }
        return left.count < right.count
    }
    public static func files(_ list: NativeJSON) -> [NativeJSON] {
        list["unavailable"] != .null ? [] : list["files"].array.prefix(2000).filter { $0["path"].string != nil && $0["root"].string != nil }.sorted(by: compare)
    }
    public static func contentHidden(_ file: NativeJSON) -> Bool { file["secret"].bool || file["notRetained"].bool || file["large"].bool || file["binary"].bool }
    /** The one short note on a file: why its content is absent, otherwise who changed it. */
    public static func fileNote(_ file: NativeJSON) -> String? {
        if file["secret"].bool { return "可能含密钥，只列路径" }
        if file["notRetained"].bool { return "内容没有留存" }
        if file["large"].bool { return "超过 1 MB，打开文件查看" }
        if file["binary"].bool { return "二进制文件" }
        if file["byCommand"].bool { return "由命令修改" }
        if file["byPerson"].bool { return "你的修改" }
        if file["byUser"].bool { return "两轮之间改动" }
        return nil
    }
    /** Why the scope has nothing to show, in the web's words. */
    public static func empty(_ list: NativeJSON) -> (title: String, detail: String?)? {
        let side = "本轮和这个会话不受影响。"
        switch list["unavailable"].string {
        case "no-turns": return ("这个会话还没有记录到改动", nil)
        case "not-git": return ("这个文件夹不是 Git 仓库的顶层", nil)
        case "git-missing": return ("找不到 Git", side)
        case "git-failed": return ("读不到 Git 状态", side)
        case "no-head": return ("还没有提交", nil)
        case "no-base": return ("没有可比较的主分支", nil)
        default: break
        }
        guard list["files"].array.isEmpty else { return nil }
        switch list["scope"].string {
        case "turn": return (list["running"].bool ? "还没有改动文件" : "这一轮没有改动文件", nil)
        case "session": return ("这个会话没有留下改动", nil)
        case "uncommitted": return ("没有未提交的改动", nil)
        default: return ("和分叉点相比没有改动", nil)
        }
    }
    /** The record does not cover every file. */
    public static let partialWords = "列表可能不完整"

    /** The detail column is measured after the system split view has laid out its sidebar. */
    public static func fileColumnWidth(detail: Double, accessibility: Bool) -> Double? {
        guard !accessibility, detail.isFinite, detail >= 780 else { return nil }
        let files = min(280, max(224, (detail * 0.29).rounded(.down)))
        return detail - files >= 520 ? files : nil
    }

    // MARK: routes

    private static func session(_ id: String) throws -> String {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        return "/link/api/tasks/" + id
    }
    static func encode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
    public static func turnsPath(_ id: String) throws -> String { try session(id) + "/changes/turns" }
    public static func listPath(_ id: String, scope: PhoneReviewScope, turnId: String? = nil) throws -> String {
        if let turnId, scope != .turn || PhoneWorkItems.message(.string(turnId)) == nil { throw NativeFailure.invalidRecord }
        return try session(id) + "/changes?scope=" + scope.rawValue + (turnId.map { "&turn=" + PhoneWorkItems.query($0) } ?? "")
    }
    /** Whole-file context, as the web asks: the page folds what it does not show and opens it without asking again. */
    public static func filePath(_ id: String, scope: PhoneReviewScope, turnId: String?, root: String, path: String) throws -> String {
        guard !root.isEmpty, root.utf8.count <= 160, !path.isEmpty, path.utf8.count <= 1024 else { throw NativeFailure.invalidRecord }
        var query = "scope=" + scope.rawValue
        if let turnId { query += "&turn=" + encode(turnId) }
        return try session(id) + "/changes/file?" + query + "&root=" + encode(root) + "&path=" + encode(path) + "&context=100000"
    }
    public static func notesPath(_ id: String) throws -> String { try session(id) + "/review-notes" }

    // MARK: writes

    private static func noteId(_ id: String) throws -> String {
        guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}") else { throw NativeFailure.invalidRecord }
        return id
    }
    public static func create(sessionId: String, root: String, path: String, selection: PhoneLineSelection, scope: PhoneReviewScope, turnId: String?,
        lines: [String], text: String) throws -> NativePendingWrite {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= textChars, !lines.isEmpty, lines.count == selection.end - selection.start + 1,
              selection.end - selection.start < lineLimit, !root.isEmpty, !path.isEmpty else { throw NativeFailure.invalidRecord }
        var fields: [String: NativeJSON] = ["root": .string(root), "path": .string(path),
            "range": .object(["start": .number(Double(selection.start)), "end": .number(Double(selection.end))]), "side": .string(selection.side.rawValue),
            "scope": .string(scope.rawValue), "lines": .array(lines.map { .string(cut($0)) }), "text": .string(trimmed)]
        if let turnId { fields["turnId"] = .string(turnId) }
        return try NativePendingWrite(method: .post, path: try notesPath(sessionId), fields: fields)
    }
    public static func edit(sessionId: String, noteId id: String, text: String) throws -> NativePendingWrite {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= textChars else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: try notesPath(sessionId) + "/" + noteId(id) + "/edit", fields: ["text": .string(trimmed)])
    }
    public static func status(sessionId: String, noteId id: String, status: PhoneReviewNote.Status) throws -> NativePendingWrite {
        guard status == .claimed || status == .reviewed else { throw NativeFailure.invalidRecord }
        return try NativePendingWrite(method: .post, path: try notesPath(sessionId) + "/" + noteId(id) + "/status", fields: ["status": .string(status.rawValue)])
    }
    public static func remove(sessionId: String, noteId id: String) throws -> NativePendingWrite {
        try NativePendingWrite(method: .post, path: try notesPath(sessionId) + "/" + noteId(id) + "/delete", fields: [:])
    }
    /** The pending notes as one message, now or (`queue`) with the next turn. */
    public static func send(sessionId: String, noteIds: [String], queue: Bool) throws -> NativePendingWrite {
        guard !noteIds.isEmpty, noteIds.count <= perSend, Set(noteIds).count == noteIds.count else { throw NativeFailure.invalidRecord }
        var fields: [String: NativeJSON] = ["noteIds": .array(try noteIds.map { .string(try noteId($0)) })]
        if queue { fields["queue"] = .bool(true) }
        return try NativePendingWrite(method: .post, path: try notesPath(sessionId) + "/send", fields: fields)
    }
    /** The Host's own retry of an open send, with its own request ID: never a second message. */
    public static func retrySend(sessionId: String, sendId: String) throws -> NativePendingWrite {
        try NativePendingWrite(method: .post, path: try notesPath(sessionId) + "/sends/" + noteId(sendId) + "/retry", fields: [:])
    }
    public static func abandonSend(sessionId: String, sendId: String) throws -> NativePendingWrite {
        try NativePendingWrite(method: .post, path: try notesPath(sessionId) + "/sends/" + noteId(sendId) + "/abandon", fields: [:])
    }
    /**
     * A send whose own answer never came, once the Host lists it open: the Host keeps it and offers the retry and the
     * abandon, so this device's copy is settled rather than sent a second time.
     */
    public static func heldByHost(_ write: NativePendingWrite, list: NativeJSON, sessionId: String) -> Bool {
        // Only this list's own session: another session's send is answered by that session's list alone.
        guard write.method == "POST", LinkBytes.matches(sessionId, "[A-Za-z0-9_-]{1,160}"), write.path == "/link/api/tasks/\(sessionId)/review-notes/send",
              let body = try? NativeJSON.decode(write.body) else { return false }
        let ids = Set(body["noteIds"].array.compactMap(\.string))
        guard !ids.isEmpty else { return false }
        let notes = notes(list)
        // Open on the Host, or already through: either way the Host, not this copy, answers it now. A note the list does
        // not have says nothing (deleted, or past the list), so it never settles a send.
        return list["openSends"].array.contains { Set($0["noteIds"].array.compactMap(\.string)) == ids }
            || ids.allSatisfy { id in notes.first { $0.id == id }.map { $0.status != .pending || $0.queued } ?? false }
    }
    /** What a pending review write says while its answer is unknown. */
    public static func pendingWords(_ write: NativePendingWrite) -> String? {
        guard write.path.contains("/review-notes") else { return nil }
        return write.path.hasSuffix("/send") || write.path.hasSuffix("/retry") ? "发送结果未知" : "反馈的修改结果待确认"
    }
}
