import Foundation

/** A limit's state, as `quotaWindowState` in the protocol: amber from `nearPercent`, red at the limit. */
public enum PhoneQuotaState: Int, Comparable, Sendable {
    case ok = 0, near, limited
    init(_ value: NativeJSON) { self = value.string == "limited" ? .limited : value.string == "near" ? .near : .ok }
    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/** One window of a Harness's limits as the sheet draws it. */
public struct PhoneQuotaWindow: Equatable, Sendable, Identifiable {
    public let id: String
    /** The model group's name, where the Harness meters several (Antigravity). */
    public let group: String?
    public let name: String
    public let state: PhoneQuotaState
    /** 0–100, never 100 below the limit; nil when the Harness gave only a state, which `status` then says. */
    public let percent: Int?
    public let status: String?
    /** 「已用 68%」, or the state's words without a figure. */
    public var used: String { percent.map { "已用 \($0)%" } ?? status ?? "" }
    public let reset: String?
    /** 「按现在的速度约 周四 14:00 用完」, when the current rate runs out before the reset. */
    public let pace: String?
}

/** One Harness's block on the 额度 tab. */
public struct PhoneQuotaBlock: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let mark: String?
    /** Nil when nothing it said still holds. */
    public let state: PhoneQuotaState?
    public let windows: [PhoneQuotaWindow]
    /** The Harness said the account is at a limit none of its windows shows: 「额度已用尽」. */
    public let accountLimited: Bool
    /** Plan and masked account, each only when the Harness said it. */
    public let facts: [String]
    public let balance: String?
    public let reading: Bool
    /** Without figures: why (未登录, 无 API 密钥, 读取失败, 只在对话中报告, 未添加, 尚未报告额度). */
    public let note: String?
    /** The read failed for another reason, so 重试 may ask again. */
    public let retryable: Bool
    /** 「更新于 3 分钟前」. */
    public let observed: String?
}

public struct PhoneQuotaPage: Equatable, Sendable {
    public let blocks: [PhoneQuotaBlock]
    /** Names of Harnesses whose program never reports limits: the 「不报告额度」 line. */
    public let silent: [String]
}

/** A total, a bucket and a row of the 用量 tab. */
public struct PhoneUsageBucket: Equatable, Sendable, Identifiable {
    public let id: Int
    public let label: String
    public let tokens: Int
}

public struct PhoneUsageRow: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let detail: String?
    /** The Harness the row is of, for its mark. */
    public let harnessId: String?
    public let tokens: Int?
    /** The row's share of the period's tokens, 0…1. */
    public let share: Double
    public let tokensText: String
    public let cost: String?
}

public struct PhoneUsageSummary: Equatable, Sendable {
    public let tokens: Int?
    /** 「12.4k」, 「0」 for an empty period, 「未报告」 when nothing reported tokens. */
    public let tokensText: String
    /** 「12 轮」「3 次请求」「输入 9.1k · 输出 3.3k」「缓存命中 42%」. */
    public let facts: [String]
    /** 「$1.20」「¥3.40」, one per currency. */
    public let costs: [String]
    public let estimated: Bool
    public let buckets: [PhoneUsageBucket]
    public let rows: [PhoneUsageRow]
    public let empty: Bool
    /** The Host read only part of the period's records. */
    public let truncated: Bool
}

/** The desktop's 额度与用量 rules (`apps/web/src/usage/limits.ts`, `usage.ts`), in the phone's words. */
public enum PhoneUsage {
    public static let nearPercent = 80.0
    public static let periods = ["1", "7", "30", "90"]
    public static let groups = ["harness", "model", "project"]

    // MARK: 额度

    private static func number(_ value: NativeJSON) -> Double? {
        if case let .number(result) = value, result.isFinite { return result }
        return nil
    }

    static func windowState(_ window: NativeJSON) -> PhoneQuotaState {
        let said = PhoneQuotaState(window["state"])
        guard let used = number(window["usedPercent"]) else { return said }
        let figure: PhoneQuotaState = used >= 100 ? .limited : used >= nearPercent ? .near : .ok
        return max(said, figure)
    }

    /** `currentQuota`: windows past their reset go, a balance reported alone stays; nil once nothing is left. */
    static func current(_ quota: NativeJSON, now: Date) -> (windows: [NativeJSON], state: PhoneQuotaState)? {
        guard case .object = quota else { return nil }
        let all = quota["windows"].array
        let windows = all.filter { window in
            guard window["resetsAt"] != .null else { return true }
            return PhoneTime.parse(window["resetsAt"]).map { $0 > now } ?? false
        }
        if windows.isEmpty && (!all.isEmpty || number(quota["balanceCents"]) == nil) { return nil }
        let said = PhoneQuotaState(quota["state"])
        if windows.count == all.count { return (windows, said) }
        let account = said == .limited && !all.contains { windowState($0) == .limited }
        return (windows, windows.map(windowState).reduce(account ? .limited : .ok) { max($0, $1) })
    }

    /**
     * What a conversation says above its input once its Harness has used a limit up: which one, and when the last of the
     * used-up windows starts over. Nil while nothing is used up, so a run is never held back by a guess.
     */
    public static func limitNotice(_ catalog: NativeJSON, harnessId: String, now: Date) -> String? {
        guard let harness = catalog["harnesses"].array.first(where: { $0["id"].string == harnessId }),
              let held = current(harness["quota"], now: now), held.state == .limited else { return nil }
        let name = PhoneStart.engineName(harness)
        let used = held.windows.filter { windowState($0) == .limited }
        let resets = used.compactMap { PhoneTime.parse($0["resetsAt"]) }.max()
        let what = used.count == 1 ? name + " " + windowName(used[0]) + "的额度已用完" : name + " 的额度已用完"
        return resets.map { what + " · " + resetWords($0, now: now) } ?? what
    }

    /** The worst state of every Harness's limits that still hold; the toolbar's gauge is tinted by it. */
    public static func worst(_ catalog: NativeJSON, now: Date) -> PhoneQuotaState {
        catalog["harnesses"].array.compactMap { current($0["quota"], now: now)?.state }.max() ?? .ok
    }

    private static func lengthWords(_ minutes: Int) -> String {
        if minutes % 1440 == 0 { return "\(minutes / 1440) 天" }
        if minutes % 60 == 0 { return "\(minutes / 60) 小时" }
        return "\(minutes) 分钟"
    }

    static func windowName(_ window: NativeJSON) -> String {
        switch window["kind"].string {
        case "five-hour": "每 5 小时"
        case "weekly": "每周"
        case "weekly-opus": "每周 · Opus"
        case "weekly-sonnet": "每周 · Sonnet"
        case "billing-period": "本期"
        default: window["windowMinutes"].integer.flatMap { $0 > 0 ? "每 " + lengthWords(Int($0)) : nil } ?? "额度"
        }
    }

    static func windowLength(_ window: NativeJSON) -> TimeInterval? {
        switch window["kind"].string {
        case "five-hour": 5 * 3600
        case "weekly", "weekly-opus", "weekly-sonnet": 7 * 86400
        case "rolling": window["windowMinutes"].integer.flatMap { $0 > 0 ? TimeInterval($0) * 60 : nil }
        default: nil
        }
    }

    /** 「5 天 23 小时后重置」: two units at most, down to the minute; 「即将重置」 under a minute. */
    public static func resetWords(_ resetsAt: Date, now: Date) -> String {
        let left = resetsAt.timeIntervalSince(now)
        if left < 60 { return "即将重置" }
        let total = Int(left / 60), days = total / 1440, hours = total % 1440 / 60, minutes = total % 60
        let span = days > 0 ? "\(days) 天" + (hours > 0 ? " \(hours) 小时" : "")
            : hours > 0 ? "\(hours) 小时" + (minutes > 0 ? " \(minutes) 分钟" : "") : "\(minutes) 分钟"
        return span + "后重置"
    }

    /** A whole figure that never reads 100 before the limit is reached. */
    public static func shownPercent(_ used: Double) -> Int { used >= 100 ? 100 : max(0, min(99, Int(used.rounded()))) }

    /**
     * When the window runs out at the rate used since it began (its reset less its length), if that is before the reset.
     * Nil for a window without a known length or figure, one at its limit, or one that has not started.
     */
    public static func exhaustion(_ window: NativeJSON, now: Date) -> Date? {
        guard let length = windowLength(window), let used = number(window["usedPercent"]), used > 0, used < 100,
              windowState(window) != .limited, let reset = PhoneTime.parse(window["resetsAt"]), reset > now else { return nil }
        let start = reset.addingTimeInterval(-length), elapsed = now.timeIntervalSince(start)
        guard elapsed > 0 else { return nil }
        let end = start.addingTimeInterval(elapsed * 100 / used)
        return end < reset ? max(end, now) : nil
    }

    /** 「今天 14:00」「明天 09:30」「周四 14:00」 in `timeZone`. */
    public static func shortTime(_ date: Date, now: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute, .weekday], from: date)
        let clock = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days <= 0 { return "今天 " + clock }
        if days == 1 { return "明天 " + clock }
        let names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
        return names[((parts.weekday ?? 1) - 1) % 7] + " " + clock
    }

    /** 「更新于刚刚」「更新于 3 分钟前」. */
    public static func observedWords(_ date: Date, now: Date) -> String {
        let elapsed = max(0, now.timeIntervalSince(date))
        if elapsed < 60 { return "更新于刚刚" }
        if elapsed < 3600 { return "更新于 \(Int(elapsed / 60)) 分钟前" }
        if elapsed < 86400 { return "更新于 \(Int(elapsed / 3600)) 小时前" }
        return "更新于 \(Int(elapsed / 86400)) 天前"
    }

    private static let plans: [String: String] = [
        "free": "Free", "go": "Go", "plus": "Plus", "pro": "Pro", "prolite": "Pro Lite", "promax": "Pro Max", "max": "Max",
        "ultra": "Ultra", "team": "Team", "business": "Business", "enterprise": "Enterprise", "edu": "Edu",
        "supergrok": "SuperGrok", "supergrok-heavy": "SuperGrok Heavy",
    ]
    private static let quotaGroups = ["gemini": "Gemini 模型", "claude-gpt": "Claude 与 GPT 模型"]

    static func window(_ window: NativeJSON, now: Date, timeZone: TimeZone) -> PhoneQuotaWindow {
        let state = windowState(window), used = number(window["usedPercent"])
        let reset = PhoneTime.parse(window["resetsAt"])
        // A window with nothing used and a whole window still to go has not started: its reset only follows the clock.
        let unstarted = used == 0 && windowLength(window).map { length in reset.map { abs($0.timeIntervalSince(now) - length) <= 60 } ?? false } == true
        let pace = exhaustion(window, now: now).map { "按现在的速度约 " + shortTime($0, now: now, timeZone: timeZone) + " 用完" }
        let group = window["group"].string.flatMap { quotaGroups[$0] }
        return PhoneQuotaWindow(id: "\(window["group"].string ?? ""):\(window["kind"].string ?? ""):\(window["windowMinutes"].integer.map(String.init) ?? "")",
            group: group, name: windowName(window), state: state, percent: used.map(shownPercent),
            status: used == nil && state != .ok ? (state == .limited ? "已用尽" : "将用尽") : nil,
            reset: unstarted ? nil : reset.map { resetWords($0, now: now) }, pace: pace)
    }

    private static func note(_ harness: NativeJSON) -> (String, Bool) {
        let read = harness["quotaRead"]
        switch read["failed"]["reason"].string {
        case "login": return ("未登录", false)
        case "no-key": return ("无 API 密钥", false)
        case .some: return ("读取失败", true)
        case nil: break
        }
        if read["afterTurn"].bool { return ("只在对话中报告", false) }
        if harness["offer"] != .null { return ("未添加", false) }
        return ("尚未报告额度", false)
    }

    /**
     * `limitHarnesses`: those on their own login that are ready, and any that reported limits. Those that can report are
     * listed, the ones with figures first; those that never do are named in one line.
     */
    public static func quotaPage(_ catalog: NativeJSON, now: Date, timeZone: TimeZone = .current) -> PhoneQuotaPage {
        let own = catalog["harnesses"].array.filter { harness in
            harness["quota"] != .null || (harness["capabilities"]["models"]["owner"].string == "harness" && harness["status"].string == "ready")
        }
        var blocks: [PhoneQuotaBlock] = [], silent: [String] = []
        for harness in own {
            guard let id = harness["id"].string else { continue }
            let name = PhoneStart.engineName(harness)
            guard harness["quota"] != .null || harness["capabilities"]["models"]["quota"].bool else { silent.append(name); continue }
            let quota = harness["quota"], held = current(quota, now: now)
            let running = harness["quotaRead"]["running"].bool
            guard let held else {
                let (words, retry) = note(harness)
                blocks.append(PhoneQuotaBlock(id: id, name: name, mark: PhoneStart.mark(harness), state: nil, windows: [], accountLimited: false,
                    facts: [], balance: nil, reading: running, note: running ? nil : words, retryable: !running && retry, observed: nil))
                continue
            }
            let windows = held.windows.map { window($0, now: now, timeZone: timeZone) }
            let facts = [quota["plan"].string.flatMap { plans[$0] }, quota["account"].string.flatMap { $0.isEmpty || $0.utf8.count > 128 ? nil : $0 }].compactMap { $0 }
            let cents = number(quota["balanceCents"])
            // A balance beside windows shows only with money in it; a balance reported alone always shows.
            let balance = cents.flatMap { $0 > 0 || windows.isEmpty ? "余额 " + money($0 / 100, currency: quota["currency"].string ?? "USD", fraction: 2) : nil }
            blocks.append(PhoneQuotaBlock(id: id, name: name, mark: PhoneStart.mark(harness), state: held.state, windows: windows,
                accountLimited: held.state == .limited && !windows.contains { $0.state == .limited }, facts: facts, balance: balance,
                reading: running, note: nil, retryable: false, observed: PhoneTime.parse(quota["observedAt"]).map { observedWords($0, now: now) }))
        }
        let ordered = blocks.enumerated().sorted { a, b in
            (a.element.state == nil ? 1 : 0, a.offset) < (b.element.state == nil ? 1 : 0, b.offset)
        }.map(\.element)
        return PhoneQuotaPage(blocks: ordered, silent: silent)
    }

    // MARK: 用量

    /** 850, 9.1k, 12.4k, 124k, 1.2M: the web's `formatTokens`. */
    public static func tokens(_ value: Int) -> String {
        if value < 1000 { return "\(value)" }
        // Halves round up, as JavaScript's toFixed does, where printf would round them to even.
        func fixed(_ amount: Double, _ places: Int) -> String {
            let scale = places == 1 ? 10.0 : 1.0
            let text = String(format: "%.\(places)f", (amount * scale).rounded(.toNearestOrAwayFromZero) / scale)
            return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
        }
        if value < 999_500 { return fixed(Double(value) / 1000, value < 99_950 ? 1 : 0) + "k" }
        return fixed(Double(value) / 1_000_000, 1) + "M"
    }

    private static func grouped(_ value: Double, fraction: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true; formatter.groupingSeparator = ","; formatter.groupingSize = 3
        formatter.minimumFractionDigits = fraction; formatter.maximumFractionDigits = fraction
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.\(fraction)f", value)
    }

    static func money(_ value: Double, currency: String, fraction: Int) -> String {
        (currency == "CNY" ? "¥" : "$") + grouped(value, fraction: fraction)
    }

    /** 「$0.0021」「¥12.50」: four places under one, two above, so a small request never reads as nothing. */
    public static func cost(micros: Double, currency: String) -> String {
        let value = micros / 1_000_000
        return money(value, currency: currency, fraction: value != 0 && value < 1 ? 4 : 2)
    }

    private struct Merged {
        var row: NativeJSON
        var tokens: Int?
        var input = 0, output = 0
        var costs: [String: Double] = [:]
    }

    private static func costs(_ list: NativeJSON) -> (amounts: [String: Double], estimated: Bool) {
        var amounts: [String: Double] = [:], estimated = false
        for item in list.array {
            guard let currency = item["currency"].string, ["USD", "CNY"].contains(currency), let micros = number(item["micros"]) else { continue }
            amounts[currency, default: 0] += micros
            if item["estimated"].bool { estimated = true }
        }
        return (amounts, estimated)
    }

    private static func costText(_ amounts: [String: Double]) -> String? {
        let parts = ["USD", "CNY"].compactMap { currency in amounts[currency].map { cost(micros: $0, currency: currency) } }
        return parts.isEmpty ? nil : parts.joined(separator: " + ")
    }

    private static func bucketLabel(_ start: Date, period: String, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.month, .day, .hour], from: start)
        return period == "1" ? String(format: "%02d:00", parts.hour ?? 0) : "\(parts.month ?? 0)/\(parts.day ?? 0)"
    }

    /** What a row is of: a Harness, a model (with its service or Harness), or a project; 其他 for none this device sees. */
    private static func rowName(_ row: NativeJSON, group: String, catalog: NativeJSON) -> (name: String, detail: String?, harness: String?) {
        func harness(_ id: String) -> String {
            catalog["harnesses"].array.first { $0["id"].string == id }.map(PhoneStart.engineName) ?? id
        }
        switch group {
        case "harness":
            let id = row["harness"].string ?? ""
            return (harness(id), nil, id)
        case "model":
            let service = row["providerId"].string.map { id in catalog["providers"].array.first { $0["id"].string == id }?["name"].string ?? id }
            let detail = service ?? row["harness"].string.map { harness($0) + " · 自己登录" }
            return (row["model"].string ?? "未报告", detail, nil)
        default:
            let project = catalog["workspaces"].array.first { $0["id"].string == row["projectId"].string && row["projectId"] != .null }
            if project?["id"].string == "default" { return ("默认文件夹", nil, nil) }
            return (project?["name"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "其他", nil, nil)
        }
    }

    /**
     * A `UsageSummary` as the tab draws it: rows of one thing merged across sources (`mergeSources`), totals over every
     * row, tokens per bucket from the series, and the cache-hit share only over uses that reported cache reads.
     */
    public static func summary(_ value: NativeJSON, catalog: NativeJSON) -> PhoneUsageSummary? {
        guard let period = value["period"].string, periods.contains(period), let group = value["group"].string, groups.contains(group),
              case .array = value["rows"], case .array = value["buckets"] else { return nil }
        let timeZone = value["timeZone"].string.flatMap(TimeZone.init(identifier:)) ?? .current
        var merged: [String: Merged] = [:], order: [String] = []
        var turns = 0, requests = 0, input = 0, output = 0, measuredTokens = false
        var allCosts: [String: Double] = [:], estimated = false
        for row in value["rows"].array {
            let key = ["harness", "providerId", "model", "projectId", "agentId", "sessionId"].map { row[$0].string ?? "\u{0}" }.joined(separator: "\u{1}")
            let usage = row["usage"]
            let rowInput = number(usage["inputTokens"]).map { max(0, Int($0)) }, rowOutput = number(usage["outputTokens"]).map { max(0, Int($0)) }
            turns += number(row["turns"]).map { max(0, Int($0)) } ?? 0
            requests += number(row["requests"]).map { max(0, Int($0)) } ?? 0
            let (amounts, rowEstimated) = costs(row["cost"])
            estimated = estimated || rowEstimated
            for (currency, micros) in amounts { allCosts[currency, default: 0] += micros }
            var into = merged[key] ?? { order.append(key); return Merged(row: row) }()
            if let rowInput, let rowOutput {
                measuredTokens = true
                input += rowInput; output += rowOutput
                into.input += rowInput; into.output += rowOutput
                into.tokens = (into.tokens ?? 0) + rowInput + rowOutput
            }
            for (currency, micros) in amounts { into.costs[currency, default: 0] += micros }
            merged[key] = into
        }
        let total = input + output
        let rows = order.compactMap { merged[$0] }.sorted { ($0.tokens ?? -1) > ($1.tokens ?? -1) }.enumerated().map { index, item in
            let named = rowName(item.row, group: group, catalog: catalog)
            return PhoneUsageRow(id: "\(index):" + named.name, name: named.name, detail: named.detail, harnessId: named.harness, tokens: item.tokens,
                share: total > 0 ? Double(item.tokens ?? 0) / Double(total) : 0, tokensText: item.tokens.map(tokens) ?? "未报告",
                cost: costText(item.costs))
        }
        let starts = value["buckets"].array.prefix(2400)
        var perBucket = [Int](repeating: 0, count: starts.count)
        var cacheRead = 0.0, cacheBase = 0.0
        for point in value["series"].array {
            guard let index = point["bucket"].integer.map(Int.init), index < perBucket.count else { continue }
            perBucket[index] += Int(max(0, number(point["inputTokens"]) ?? 0) + max(0, number(point["outputTokens"]) ?? 0))
            cacheRead += max(0, number(point["cacheReadTokens"]) ?? 0); cacheBase += max(0, number(point["cacheBase"]) ?? 0)
        }
        let buckets = starts.enumerated().map { index, start in
            PhoneUsageBucket(id: index, label: PhoneTime.parse(start).map { bucketLabel($0, period: period, timeZone: timeZone) } ?? "", tokens: perBucket[index])
        }
        let empty = value["rows"].array.isEmpty
        var facts: [String] = []
        if turns > 0 { facts.append("\(turns) 轮") }
        if requests > 0 || turns == 0 { facts.append("\(requests) 次请求") }
        if measuredTokens { facts.append("输入 \(tokens(input)) · 输出 \(tokens(output))") }
        if cacheBase > 0 { facts.append("缓存命中 \(Int((cacheRead / cacheBase * 100).rounded()))%") }
        let costList = ["USD", "CNY"].compactMap { currency in allCosts[currency].map { cost(micros: $0, currency: currency) } }
        return PhoneUsageSummary(tokens: measuredTokens ? total : nil, tokensText: measuredTokens ? tokens(total) : empty ? "0" : "未报告",
            facts: facts, costs: costList, estimated: estimated && !costList.isEmpty, buckets: buckets, rows: rows, empty: empty,
            truncated: value["truncated"].bool)
    }
}
