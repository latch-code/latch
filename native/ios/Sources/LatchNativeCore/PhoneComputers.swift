import Foundation

public enum PhoneAttentionKind: String, Sendable, Equatable {
    case approval, question, stuck
    /** The second line's word, as the desktop's 等你处理 says it. */
    public var words: String {
        switch self { case .approval: "审批"; case .question: "问题"; case .stuck: "没有动静" }
    }
}

/** One session waiting on another computer: its ID, a cleaned title, why it waits and since when. */
public struct PhoneComputerItem: Sendable, Equatable {
    public let taskId: String
    public let title: String
    public let kind: PhoneAttentionKind
    public let since: Date?
}

/** One other computer in 等你处理: its rows while it answers, or one grey 「离线前 N 项」 line while it does not. */
public struct PhoneComputerGroup: Sendable, Equatable {
    public let id: String
    public let name: String
    public let live: Bool
    public let items: [PhoneComputerItem]
}

/**
 * Several computers on one phone, judged from each computer's own list connection (`NativeListWatcher`). 等你处理 uses
 * `PhoneSessions.waitsOnYou`, the selected computer's own rule; names follow the desktop's (`computers.cjs`), so a name
 * that could pass for another always carries its hostId.
 */
public enum PhoneComputers {
    public static let itemLimit = 50
    public static let titleLimit = 80
    /** A session ID the conversation can open (`NativeWorkspace.detail`); other rows are not listed. */
    static func listable(_ id: String?) -> Bool { id.map { LinkBytes.matches($0, "[A-Za-z0-9_-]{1,160}") } ?? false }
    /** Why a session waits, or nil when it does not; a stop already asked for answers all of these. */
    public static func kind(_ task: NativeJSON) -> PhoneAttentionKind? {
        guard !task["archived"].bool, PhoneSessions.waitsOnYou(task) else { return nil }
        if task["status"].string == "waiting-approval" { return .approval }
        if (task["pendingQuestions"].integer ?? 0) > 0 { return .question }
        return .stuck
    }
    /** The newest 50 waiting sessions of one computer's list, titles cleaned and cut to 80 characters. */
    public static func attention(_ snapshot: NativeJSON) -> [PhoneComputerItem] {
        let items = snapshot["tasks"].array.compactMap { task -> PhoneComputerItem? in
            guard listable(task["id"].string), let id = task["id"].string, let kind = kind(task) else { return nil }
            let live = task["live"], asked = PhoneTime.parse(live["unrecognized"]["at"])
            let since = (kind == .stuck && PhoneSessions.stuckOnRequest(live) ? asked : nil) ?? PhoneTime.parse(live["lastEventAt"]) ?? PhoneTime.parse(task["updatedAt"])
            return PhoneComputerItem(taskId: id, title: title(task["title"].string), kind: kind, since: since)
        }
        return Array(items.sorted { ($0.since ?? .distantPast) > ($1.since ?? .distantPast) }.prefix(itemLimit))
    }
    /** Control, format, separator and default-ignorable characters out, then at most 80 code points. */
    public static func title(_ value: String?) -> String {
        var kept = String.UnicodeScalarView()
        for scalar in (value ?? "").unicodeScalars where !invisible(scalar) {
            guard kept.count < titleLimit else { break }
            kept.append(scalar)
        }
        return String(kept).trimmingCharacters(in: .whitespaces)
    }
    private static func invisible(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .control, .format, .surrogate, .privateUse, .unassigned, .lineSeparator, .paragraphSeparator: return true
        default: return scalar.properties.isDefaultIgnorableCodePoint
        }
    }
    /** A name as two names are compared: NFKC, nothing invisible, case folded. */
    public static func sameName(_ value: String) -> String {
        String(String.UnicodeScalarView(value.precomposedStringWithCompatibilityMapping.unicodeScalars.filter { !invisible($0) })).lowercased()
    }
    private nonisolated(unsafe) static let lookAlike = try! NSRegularExpression(pattern:
        "[\\p{Script=Cyrillic}\\p{Script=Greek}\\p{Script=Armenian}\\p{Script=Cherokee}\\p{Script=Coptic}\\p{Script=Lisu}\\p{Script=Canadian_Aboriginal}\\p{Script=Tifinagh}\\p{Script=Glagolitic}\\p{Script=Georgian}]")
    private nonisolated(unsafe) static let latin = try! NSRegularExpression(pattern: "\\p{Script=Latin}")
    /** Latin mixed with a script of Latin look-alikes (build-mіni with a Cyrillic і); Han, kana or Hangul beside Latin is an ordinary name. */
    public static func mixedScript(_ name: String) -> Bool {
        let text = name.precomposedStringWithCompatibilityMapping, range = NSRange(text.startIndex..., in: text)
        return latin.firstMatch(in: text, range: range) != nil && lookAlike.firstMatch(in: text, range: range) != nil
    }
    /** Each computer's name as the phone shows it: one two others share, or one that mixes look-alike scripts, gets the first four characters of its hostId. */
    public static func names(_ computers: [(id: String, hostId: String, name: String)]) -> [String: String] {
        var counts: [String: Int] = [:]
        for computer in computers { counts[sameName(computer.name), default: 0] += 1 }
        var result: [String: String] = [:]
        for computer in computers {
            let marked = (counts[sameName(computer.name)] ?? 0) > 1 || mixedScript(computer.name)
            result[computer.id] = marked ? computer.name + " " + String(computer.hostId.prefix(4)) : computer.name
        }
        return result
    }
    /** 在线, 正在连接, 不在线 · 上次在线 10:42, 已被移除, 不是这台电脑. */
    public static func stateWords(_ state: NativeComputerState?, lastSeen: Date?) -> String {
        switch state {
        case .online?: "在线"
        case .offline?: lastSeen.map { "不在线 · 上次在线 " + PhoneTime.clock($0) } ?? "不在线"
        case .revoked?: "已被移除"
        case .wrongHost?: "不是这台电脑"
        case .connecting?, nil: "正在连接"
        }
    }
    /** The menu row's second line: state, then how many wait there now, or how many waited before it went away. */
    public static func menuLine(state: NativeComputerState?, lastSeen: Date?, waiting: Int) -> String {
        let words = stateWords(state, lastSeen: lastSeen)
        guard waiting > 0 else { return words }
        if state == .online { return words + " · 等你处理 \(waiting)" }
        if state == .revoked || state == .wrongHost { return words }
        return words + " · 离线前 \(waiting) 项"
    }
    /**
     * 「其他电脑」 under 等你处理, in the order the computers are listed: live rows while a computer answers, a single
     * 「离线前」 group while it does not, nothing once it is not that computer or has removed this phone.
     */
    public static func groups(_ readings: [(id: String, name: String, state: NativeComputerState?, list: NativeJSON)]) -> [PhoneComputerGroup] {
        readings.compactMap { reading in
            guard let state = reading.state, state != .revoked, state != .wrongHost else { return nil }
            let items = attention(reading.list)
            return items.isEmpty ? nil : PhoneComputerGroup(id: reading.id, name: reading.name, live: state == .online, items: items)
        }
    }
    /** Whether a computer's new reading lists a waiting session its previous reading did not; the first reading only sets the baseline. */
    public static func fresh(previous: Set<String>?, now items: [PhoneComputerItem]) -> Bool {
        guard let previous else { return false }
        return items.contains { !previous.contains($0.taskId) }
    }
    /** A notification never names a session: the screen it lights may be locked, and the title is content. */
    public static func notificationBody(_ name: String) -> String { name + " · 有新的等你处理" }
}

/**
 * What the App keeps of the other computers' readings, and the guards on them: a reading counts only under the token of
 * the latest `watch`, for a computer still watched and not the one selected. Readings and notification baselines of
 * computers no longer watched go with each `watch`, so switching away and back never notifies about what was there.
 */
public struct PhoneComputerDesk: Sendable {
    public enum Outcome: Sendable {
        case dropped, kept
        /** Something new waits there: notify, and lead the tap to this session. */
        case notify(session: String)
        /** That computer removed this device with a proof bound to both: retire the profile, never dial it again. */
        case retire(VerifiedNativeRevocation)
    }
    public private(set) var token = UUID()
    public private(set) var readings: [String: NativeWatchReading] = [:]
    private var selected: String?
    private var watched: Set<String> = []
    private var baselines: [String: Set<String>] = [:]
    public init() {}
    /** A new set of computers to read; the token every reading must carry. */
    public mutating func watch(selected: String?, others: [String]) -> UUID {
        token = UUID(); self.selected = selected; watched = Set(others).subtracting(selected.map { [$0] } ?? [])
        readings = readings.filter { watched.contains($0.key) }
        baselines = baselines.filter { watched.contains($0.key) }
        return token
    }
    /** Nothing published before this counts any more. */
    public mutating func stop() { token = UUID() }
    public mutating func receive(_ reading: NativeWatchReading, notifying: Bool) -> Outcome {
        guard reading.token == token, reading.id != selected, watched.contains(reading.id) else { return .dropped }
        if let proof = reading.revocation, reading.state == .revoked {
            readings[reading.id] = nil; baselines[reading.id] = nil
            return .retire(proof)
        }
        readings[reading.id] = reading
        guard reading.state == .online else { return .kept }
        let items = PhoneComputers.attention(reading.list), known = baselines[reading.id]
        baselines[reading.id] = Set(items.map(\.taskId))
        guard notifying, PhoneComputers.fresh(previous: known, now: items),
              let item = items.first(where: { !(known ?? []).contains($0.taskId) }) else { return .kept }
        return .notify(session: item.taskId)
    }
}

/** Where each posted notification leads, by a random ID the notification carries instead of any name or session. In memory only. */
public struct PhoneNoticeTargets: Sendable {
    private var order: [String] = []
    private var targets: [String: (computer: String, session: String)] = [:]
    public init() {}
    public mutating func add(computer: String, session: String) -> String {
        let id = UUID().uuidString
        targets[id] = (computer, session); order.append(id)
        while order.count > 32 { targets[order.removeFirst()] = nil }
        return id
    }
    /** A tap leads once; an unknown ID leads nowhere. */
    public mutating func take(_ id: String) -> (computer: String, session: String)? {
        order.removeAll { $0 == id }
        return targets.removeValue(forKey: id)
    }
    /** A computer removed from this phone takes its known notification IDs with it. */
    public mutating func forget(computer: String) -> [String] {
        let removed = order.filter { targets[$0]?.computer == computer }
        for id in removed { targets[id] = nil }
        order.removeAll { targets[$0] == nil }
        return removed
    }
}
