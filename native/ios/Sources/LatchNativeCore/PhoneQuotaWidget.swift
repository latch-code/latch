import Foundation

/** One Harness as the Home and Lock Screen widgets draw it. */
public struct PhoneQuotaWidgetHarness: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let mark: String?
    /** Nil once nothing it said still holds: every window has reset since the App wrote the file. */
    public let state: PhoneQuotaState?
    public let windows: [PhoneQuotaWindow]
    /** The Harness said the account is at a limit none of its windows shows. */
    public let accountLimited: Bool
    /** The window a small widget and the gauges show: the worst state, then the most used, then the first. */
    public let leading: PhoneQuotaWindow?
    /** The Host read these figures longer ago than `PhoneQuotaWidget.staleAfter`. */
    public let stale: Bool
    /** 「更新于 20 分钟前」. */
    public let observed: String?
}

/**
 * The widgets' copy of the limits. The App writes it to its App Group as each live Host snapshot is adopted, and the widget
 * extension draws it with the 额度 tab's rules (`PhoneUsage.quotaPage`). It is the catalog cut down to an allow-list: a
 * Harness's id, label and mark; its account-wide state and when the Host read it; and each window's kind, length, figure,
 * state and reset. Plan, account, balance, pace, computer, session, project and any other text of the Host's never enter
 * it. Times are moved onto this device's clock, since the extension has no Host to correct them by.
 */
public enum PhoneQuotaWidget {
    public static let kind = "codes.latch.quota"
    public static let fileName = "quota-widget.json"
    public static let version = 1
    /** The Host reads limits only as sessions open, turns end or someone looks; figures older than this are drawn as out of date. */
    public static let staleAfter: TimeInterval = 15 * 60
    static let maximumHarnesses = 12, maximumWindows = 8, maximumBytes = 32_768
    public static func anonymousId(_ id: String) -> String {
        "widget-" + LinkBytes.hex(LinkBytes.hash(Data(id.utf8)).prefix(16))
    }
    /** WidgetKit can show these on the Lock Screen; even a user-defined Harness ID or display name may identify an account. */
    private static func widgetIdentity(_ harness: NativeJSON, id: String) -> (id: String, label: String, mark: NativeJSON) {
        let preset = harness["presetId"].string ?? (harness["capabilities"]["display"]["mark"].string == id ? id : "")
        let name = PhoneStart.presetName(preset), mark = name == nil ? NativeJSON.null : .string(preset)
        if !harness["account"].bool, id == preset, let name { return (id, name, mark) }
        let local = anonymousId(id)
        return (local, (name ?? "Harness") + " · " + local.suffix(4).uppercased(), mark)
    }

    private static func word(_ value: NativeJSON, _ pattern: String) -> NativeJSON {
        value.string.map { LinkBytes.matches($0, pattern) ? NativeJSON.string($0) : .null } ?? .null
    }
    private static func state(_ value: NativeJSON) -> NativeJSON {
        ["ok", "near", "limited"].contains(value.string ?? "") ? value : .null
    }
    private static func time(_ value: NativeJSON, moved offset: TimeInterval = 0) -> NativeJSON {
        PhoneTime.parse(value).map { .string(PhoneTime.format($0.addingTimeInterval(-offset))) } ?? .null
    }
    /** Fields the Harness did not say are left out rather than written as null. */
    private static func present(_ fields: [String: NativeJSON]) -> NativeJSON { .object(fields.filter { $0.value != .null }) }
    private static func figure(_ value: NativeJSON) -> NativeJSON {
        if case let .number(used) = value, used.isFinite { return .number(min(100, max(0, used))) }
        return .null
    }

    /**
     * What `catalog` gives the widgets, still on the Host's clock (`now` is the Host's): the Harnesses with windows or an
     * account-wide limit that still hold, in the catalog's order. Empty when none do, so a widget stops drawing figures the
     * Host no longer has. Compared as it is, so a new Host clock reading alone never rewrites the file.
     */
    public static func shelf(_ catalog: NativeJSON, now: Date) -> NativeJSON {
        var harnesses: [NativeJSON] = []
        for harness in catalog["harnesses"].array where harnesses.count < maximumHarnesses {
            guard let id = harness["id"].string, LinkBytes.matches(id, "[A-Za-z0-9_.-]{1,64}"),
                  let held = PhoneUsage.current(harness["quota"], now: now), !held.windows.isEmpty || held.state == .limited else { continue }
            let identity = widgetIdentity(harness, id: id)
            let windows: [NativeJSON] = held.windows.prefix(maximumWindows).map { window in
                present([
                    "kind": word(window["kind"], "[a-z0-9-]{1,32}"),
                    "windowMinutes": window["windowMinutes"].integer.map { NativeJSON.number(Double(min($0, 525_600))) } ?? .null,
                    "usedPercent": figure(window["usedPercent"]),
                    "state": state(window["state"]),
                    "resetsAt": time(window["resetsAt"]),
                ])
            }
            harnesses.append(.object([
                "id": .string(identity.id),
                "capabilities": .object(["display": present(["label": .string(identity.label), "mark": identity.mark])]),
                "quota": present(["state": state(harness["quota"]["state"]), "observedAt": time(harness["quota"]["observedAt"]), "windows": .array(windows)]),
            ]))
        }
        return .object(["harnesses": .array(harnesses)])
    }

    /** `shelf`'s file: its times moved onto this device's clock (`hostOffset` is the Host's clock less this device's). */
    public static func encoded(_ shelf: NativeJSON, hostOffset: TimeInterval) throws -> Data {
        let harnesses: [NativeJSON] = shelf["harnesses"].array.map { harness in
            guard case var .object(fields) = harness, case var .object(quota) = harness["quota"] else { return harness }
            quota["observedAt"] = time(harness["quota"]["observedAt"], moved: hostOffset)
            quota["windows"] = .array(harness["quota"]["windows"].array.map { window in
                guard case var .object(parts) = window else { return window }
                parts["resetsAt"] = time(window["resetsAt"], moved: hostOffset)
                return present(parts)
            })
            fields["quota"] = present(quota)
            return .object(fields)
        }
        let data = try NativeJSON.object(["version": .number(Double(version)), "harnesses": .array(harnesses)]).encoded()
        guard data.count <= maximumBytes else { throw NativeFailure.invalidRecord }
        return data
    }

    /** The file as the extension reads it; nil for another version, an oversized file or anything that is not one. */
    public static func decode(_ data: Data) -> NativeJSON? {
        guard data.count <= maximumBytes, let value = try? NativeJSON.decode(data), value["version"].integer == UInt64(version),
              case .array = value["harnesses"] else { return nil }
        return value
    }

    /** The Harnesses of the file at `now` on this device's clock, by the 额度 tab's rules. */
    public static func harnesses(_ shelf: NativeJSON, now: Date, timeZone: TimeZone = .current) -> [PhoneQuotaWidgetHarness] {
        let observed = Dictionary(shelf["harnesses"].array.compactMap { harness in
            harness["id"].string.map { ($0, PhoneTime.parse(harness["quota"]["observedAt"])) }
        }, uniquingKeysWith: { first, _ in first })
        return PhoneUsage.quotaPage(shelf, now: now, timeZone: timeZone).blocks.map { block in
            let leading = block.windows.enumerated().max { a, b in
                let left = (a.element.state, a.element.percent ?? -1, -a.offset), right = (b.element.state, b.element.percent ?? -1, -b.offset)
                return left < right
            }?.element
            let at = observed[block.id] ?? nil
            return PhoneQuotaWidgetHarness(id: block.id, name: block.name, mark: block.mark, state: block.state, windows: block.windows,
                accountLimited: block.accountLimited, leading: leading, stale: at.map { now.timeIntervalSince($0) > staleAfter } ?? true,
                observed: block.observed)
        }
    }

    /** What a widget draws redacted while it loads, so these words never show. */
    public static let placeholder: PhoneQuotaWidgetHarness = {
        let window = PhoneQuotaWindow(id: "placeholder", group: nil, name: "每 5 小时", state: .ok, percent: 40, status: nil, reset: "2 小时后重置", pace: nil)
        return PhoneQuotaWidgetHarness(id: "placeholder", name: "Harness", mark: nil, state: .ok, windows: [window], accountLimited: false,
            leading: window, stale: false, observed: nil)
    }()

    /** The person's choice first, then the rest in order; the first is shown when nothing or something since gone was chosen. */
    public static func ordered(_ harnesses: [PhoneQuotaWidgetHarness], chosen: String?) -> [PhoneQuotaWidgetHarness] {
        guard let chosen, let index = harnesses.firstIndex(where: { $0.id == chosen }) ?? harnesses.firstIndex(where: { $0.id == anonymousId(chosen) }) else { return harnesses }
        var result = harnesses
        result.insert(result.remove(at: index), at: 0)
        return result
    }

    /**
     * When the widgets redraw from `now` on: every five minutes for three hours, so reset and age words keep up, and at the
     * moments the words change kind: a minute before and just after each reset, and just after the figures turn stale.
     */
    public static func refreshDates(_ shelf: NativeJSON, now: Date) -> [Date] {
        let end = now.addingTimeInterval(3 * 3600)
        var dates = Set((0...36).map { now.addingTimeInterval(Double($0) * 300) })
        for harness in shelf["harnesses"].array {
            if let observed = PhoneTime.parse(harness["quota"]["observedAt"]) { dates.insert(observed.addingTimeInterval(staleAfter + 1)) }
            for window in harness["quota"]["windows"].array {
                guard let reset = PhoneTime.parse(window["resetsAt"]) else { continue }
                dates.insert(reset.addingTimeInterval(-59)); dates.insert(reset.addingTimeInterval(1))
            }
        }
        return dates.filter { $0 >= now && $0 <= end }.sorted()
    }
}
