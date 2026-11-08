import Foundation

/**
 * What the session list says, derived from the Host's summaries alone. Nothing is guessed from elapsed time: silence is the
 * Host's own judgement, and a list that may be stale draws nothing live.
 */
public enum PhoneRowStatus: Equatable, Sendable {
    case waiting, silent, stopping, running, failed
    /** Ended without an answer; `unknown` counts the results nobody can vouch for. */
    case ended(word: String, unknown: Int)
    /** The connection is down, so a row that was live may no longer be. */
    case frozen
    case read
}

public struct PhoneShelf: Equatable, Sendable {
    public let id: String
    public let label: String
    public let tasks: [NativeJSON]
}

public enum PhoneTime {
    // A list draws many of these on every update, and building a formatter costs far more than using one. Foundation documents
    // this class as safe to share, and nothing changes its options after this.
    private nonisolated(unsafe) static let fractional = formatter([.withInternetDateTime, .withFractionalSeconds])
    private nonisolated(unsafe) static let whole = formatter([.withInternetDateTime])
    private static func formatter(_ options: ISO8601DateFormatter.Options) -> ISO8601DateFormatter {
        let value = ISO8601DateFormatter()
        value.formatOptions = options
        return value
    }
    public static func parse(_ value: NativeJSON) -> Date? {
        guard let text = value.string else { return nil }
        return fractional.date(from: text) ?? whole.date(from: text)
    }
    private static func calendar() -> Calendar { var value = Calendar(identifier: .gregorian); value.timeZone = .current; return value }
    private static func days(from then: Date, to now: Date) -> Int {
        let calendar = calendar()
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: then), to: calendar.startOfDay(for: now)).day ?? 0
    }
    /** 10:42. */
    public static func clock(_ date: Date) -> String {
        let parts = calendar().dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
    /** 刚刚, 12 分钟, 3 小时, 昨天, 3 天, 上周, 10/24. */
    public static func relative(_ date: Date, now: Date = Date()) -> String {
        let elapsed = now.timeIntervalSince(date)
        if elapsed < 60 { return "刚刚" }
        if elapsed < 3600 { return "\(Int(elapsed / 60)) 分钟" }
        let count = days(from: date, to: now)
        if count <= 0 { return "\(Int(elapsed / 3600)) 小时" }
        if count == 1 { return "昨天" }
        if count < 7 { return "\(count) 天" }
        if count < 14 { return "上周" }
        let parts = calendar().dateComponents([.year, .month, .day], from: date), year = calendar().component(.year, from: now)
        let day = String(format: "%02d/%02d", parts.month ?? 0, parts.day ?? 0)
        return parts.year == year ? day : "\(parts.year ?? 0)/\(day)"
    }
    /** 14:32 today, 昨天 14:32, 10月3日 14:32. */
    public static func message(_ date: Date, now: Date = Date()) -> String {
        let count = days(from: date, to: now), parts = calendar().dateComponents([.year, .month, .day], from: date)
        if count <= 0 { return clock(date) }
        if count == 1 { return "昨天 \(clock(date))" }
        let day = "\(parts.month ?? 0)月\(parts.day ?? 0)日 \(clock(date))"
        return parts.year == calendar().component(.year, from: now) ? day : "\(parts.year ?? 0)年\(day)"
    }
    /** The one running clock: 0:47, 12:03, 1:02:03. */
    public static func runClock(seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds)), minutes = total / 60
        if minutes < 60 { return String(format: "%d:%02d", minutes, total % 60) }
        return String(format: "%d:%02d:%02d", minutes / 60, minutes % 60, total % 60)
    }
    /** A settled turn's working time: 1.2 秒, 12 秒, 2 分 13 秒, 1 小时 2 分. Nil under a second. */
    public static func duration(seconds: TimeInterval) -> String? {
        guard seconds.isFinite, seconds >= 1 else { return nil }
        if seconds < 10 {
            let tenths = (seconds * 10).rounded(.down) / 10
            return tenths == tenths.rounded() ? "\(Int(tenths)) 秒" : String(format: "%.1f 秒", tenths)
        }
        let total = Int(seconds)
        if total < 60 { return "\(total) 秒" }
        if total < 3600 { return "\(total / 60) 分 \(total % 60) 秒" }
        return "\(total / 3600) 小时 \(total % 3600 / 60) 分"
    }
}

public enum PhoneSessions {
    private static func live(_ task: NativeJSON) -> NativeJSON {
        ["running", "waiting-approval"].contains(task["status"].string ?? "") ? task["live"] : .null
    }
    /** The engine has done nothing since a request Latch could not answer: it may have stopped on it. */
    public static func stuckOnRequest(_ live: NativeJSON) -> Bool {
        guard let asked = PhoneTime.parse(live["unrecognized"]["at"]), let last = PhoneTime.parse(live["lastEventAt"]) else { return false }
        return asked >= last
    }
    /** A question leaves the status at running, so only its count says that the session waits. A stop already asked for answers all of these. */
    public static func waitsOnYou(_ task: NativeJSON) -> Bool {
        let live = live(task)
        if live["activity"].string == "cancelling" { return false }
        if task["status"].string == "waiting-approval" { return true }
        guard task["status"].string == "running" else { return false }
        return (task["pendingQuestions"].integer ?? 0) > 0 || live["silent"].bool || stuckOnRequest(live)
    }
    public static func rowStatus(_ task: NativeJSON, frozen: Bool = false) -> PhoneRowStatus {
        let status = task["status"].string, running = status == "running" || status == "waiting-approval", live = live(task)
        if running && frozen { return .frozen }
        if running && live["activity"].string == "cancelling" { return .stopping }
        if status == "waiting-approval" { return .waiting }
        if status == "running" {
            if (task["pendingQuestions"].integer ?? 0) > 0 || stuckOnRequest(live) { return .waiting }
            return live["silent"].bool ? .silent : .running
        }
        let outcome = status == "idle" ? task["runOutcome"].string : nil
        if status == "failed" || outcome == "failed" { return .failed }
        let unknown = Int(task["runEnd"]["unknownResultCount"].integer ?? 0)
        if status == "cancelled" || outcome == "cancelled" { return .ended(word: "已停止", unknown: unknown) }
        if status == "interrupted" || outcome == "interrupted" {
            return .ended(word: task["runEnd"]["reason"].string == "forced-stop" ? "已强制停止" : "已中断", unknown: unknown)
        }
        return .read
    }
    /** The run's working time on the Host's clock, without approval waits; frozen while one is open. */
    public static func runElapsed(started: NativeJSON, waited: NativeJSON, waiting: NativeJSON, hostNow: Date) -> TimeInterval? {
        guard let start = PhoneTime.parse(started) else { return nil }
        let wait = Double(waited.integer ?? 0) / 1000
        let open = PhoneTime.parse(waiting).map { max(0, hostNow.timeIntervalSince($0)) } ?? 0
        return max(0, hostNow.timeIntervalSince(start) - wait - open)
    }
    /** 运行中 1:12, or 运行中 alone when the Host did not say when the run began. */
    public static func runningWords(_ live: NativeJSON, hostNow: Date) -> String {
        guard let elapsed = runElapsed(started: live["runStartedAt"], waited: live["runWaitMs"], waiting: live["runWaitingSince"], hostNow: hostNow) else { return "运行中" }
        return "运行中 " + PhoneTime.runClock(seconds: elapsed)
    }
    /** 没有动静 3 分钟, counted from the engine's last sign of life. */
    public static func silentWords(_ live: NativeJSON, hostNow: Date) -> String {
        guard let last = PhoneTime.parse(live["lastEventAt"]) else { return "没有动静" }
        let minutes = max(1, Int(hostNow.timeIntervalSince(last) / 60))
        return minutes < 60 ? "没有动静 \(minutes) 分钟" : "没有动静 \(minutes / 60) 小时"
    }
    /** What the row's second line adds after the Agent: results nobody can vouch for come first, then its project in 等你处理, otherwise its branch. */
    public static func rowMeta(_ task: NativeJSON, project: String?) -> String? {
        let unknown = task["runEnd"]["unknownResultCount"].integer ?? 0
        if unknown > 0, ["failed", "cancelled", "interrupted", "idle"].contains(task["status"].string ?? "") { return "\(unknown) 条结果未知" }
        return project ?? task["branch"].string
    }
    private static func trim(_ path: String) -> String {
        var value = path
        while value.count > 1, value.hasSuffix("/") { value.removeLast() }
        return value
    }
    /** Recorded project identity wins over overlapping paths; sessions from before projects use the deepest primary folder. */
    public static func project(of task: NativeJSON, workspaces: [NativeJSON]) -> NativeJSON? {
        if task["mode"].string == "chat" { return nil }
        let recorded = task["workspaceId"].string
        if let recorded, recorded != "default" { return workspaces.first { $0["id"].string == recorded } }
        let saved = workspaces.filter { $0["id"].string != "default" }
        guard let cwd = task["cwd"].string.map(trim) else { return nil }
        if recorded == "default" {
            return saved.first { project in
                let folders = project["folders"].array.compactMap { $0["path"].string } + [project["path"].string].compactMap { $0 }
                return folders.contains { trim($0) == cwd }
            }
        }
        return saved.filter { project in
            guard let root = project["path"].string.map(trim) else { return false }
            return cwd == root || cwd.hasPrefix(root + "/")
        }.max { (trim($0["path"].string ?? "").count) < (trim($1["path"].string ?? "").count) }
    }
    /**
     * 等你处理 while something waits, then saved projects by their latest session, then conversations outside a project.
     * Archived sessions stay out; a search keeps every row in its own place.
     */
    public static func shelves(tasks: [NativeJSON], workspaces: [NativeJSON], query: String = "") -> [PhoneShelf] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let listed = tasks.filter { task in
            !task["archived"].bool
                && (needle.isEmpty || (task["title"].string ?? "").lowercased().contains(needle))
        }.map { (task: $0, at: PhoneTime.parse($0["updatedAt"]) ?? .distantPast) }.sorted { $0.at > $1.at }.map(\.task)
        let waiting = needle.isEmpty ? listed.filter(waitsOnYou) : []
        let shelved = Set(waiting.compactMap { $0["id"].string })
        var order: [String] = [], grouped: [String: [NativeJSON]] = [:], labels: [String: String] = [:], other: [NativeJSON] = []
        for task in listed where !shelved.contains(task["id"].string ?? "") {
            guard let project = project(of: task, workspaces: workspaces), let id = project["id"].string else { other.append(task); continue }
            if grouped[id] == nil { order.append(id); labels[id] = project["name"].string ?? id }
            grouped[id, default: []].append(task)
        }
        func pinnedFirst(_ tasks: [NativeJSON]) -> [NativeJSON] { tasks.filter { $0["pinned"].bool } + tasks.filter { !$0["pinned"].bool } }
        var result: [PhoneShelf] = []
        if !waiting.isEmpty { result.append(PhoneShelf(id: "waiting", label: "等你处理", tasks: waiting)) }
        for id in order { result.append(PhoneShelf(id: "project:" + id, label: labels[id] ?? id, tasks: pinnedFirst(grouped[id] ?? []))) }
        if !other.isEmpty { result.append(PhoneShelf(id: "other", label: "对话", tasks: pinnedFirst(other))) }
        return result
    }
}
