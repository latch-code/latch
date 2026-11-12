import Foundation

/** What the Host recorded about the computer it runs on (`HostComputerState`): the desktop app's own reports only. */
public struct PhoneHostComputer: Equatable, Sendable {
    public let wokeAt: Date?
    /** The desktop app on that Mac reported within the last minute. */
    public let desktop: Bool
    /** `busy` or `schedule`; nil when nothing is kept awake. */
    public let keepAwake: String?
    public static let unknown = PhoneHostComputer(wokeAt: nil, desktop: false, keepAwake: nil)
}

/** A scheduled time one of an Agent's schedules missed since that schedule last really ran. */
public struct PhoneMissedRun: Equatable, Sendable {
    public let automationId: String
    public let name: String
    public let at: Date
    /** `sleep`, `off` or `unknown`, from the Host's records only. */
    public let cause: String
}

/** 「电脑」 of an Agent's profile, as `GET /custom-agents/:id/computer` answers it. */
public struct PhoneAgentComputerRead: Equatable, Sendable {
    public let computer: PhoneHostComputer
    /** Newest first, as the Host lists them. */
    public let missed: [PhoneMissedRun]
}

/** One schedule's missed times, for one row with its 立即运行. */
public struct PhoneMissedGroup: Equatable, Sendable, Identifiable {
    public let automationId: String
    public let name: String
    /** 「今天 09:00：Mac 在睡眠」, newest first. */
    public let times: [String]
    public var id: String { automationId }
}

/** The section as the web's `computerView` words it: nothing the Host did not record, never 「永远在线」. */
public struct PhoneComputerView: Equatable, Sendable {
    /** 在线, 睡眠中, 保持唤醒中 or 不在线. */
    public let status: String
    public let tone: PhoneTone
    /** Why it is kept awake, behind ⓘ. */
    public let awakeFor: String?
    /** 「上次唤醒 …」's time, when the desktop app reported a wake. */
    public let woke: String?
    public let missedTotal: Int
    public let missed: [PhoneMissedGroup]
    /** Next to 「到点前后保持唤醒」 when it is on and cannot work now. */
    public let keepAwakeNote: String?
}

/** The three notification switches of an Agent, in the web's order. */
public enum PhoneNotificationKind: String, CaseIterable, Sendable {
    case completed, failed, waiting
    public var label: String {
        switch self {
        case .completed: "完成"
        case .failed: "失败"
        case .waiting: "需要你处理"
        }
    }
}

public enum PhoneAgentComputer {
    /** The Host keeps at most this many missed times per owner. */
    public static let maximum = 50
    public static func path(owner: String) throws -> String {
        guard PhoneAgents.validId(owner) else { throw NativeFailure.invalidRecord }
        return "/link/api/custom-agents/" + owner + "/computer"
    }
    /** The answer, bounded; a time with a cause or an ID this App does not know is left out rather than guessed. */
    public static func parse(_ value: NativeJSON) -> PhoneAgentComputerRead? {
        guard case .object = value["computer"] else { return nil }
        let state = value["computer"]
        let awake = state["keepAwake"].string.flatMap { ["busy", "schedule"].contains($0) ? $0 : nil }
        let computer = PhoneHostComputer(wokeAt: PhoneTime.parse(state["wokeAt"]), desktop: state["desktop"].bool, keepAwake: awake)
        let missed = value["missed"].array.prefix(maximum).compactMap { item -> PhoneMissedRun? in
            guard let id = item["automationId"].string, PhoneAgents.validAutomation(id), let at = PhoneTime.parse(item["at"]),
                  let cause = item["cause"].string, causes[cause] != nil else { return nil }
            return PhoneMissedRun(automationId: id, name: PhoneConversation.visible(String((item["name"].string ?? "定时任务").prefix(200))), at: at, cause: cause)
        }
        return PhoneAgentComputerRead(computer: computer, missed: missed)
    }
    private static let causes = ["sleep": "Mac 在睡眠", "off": "Mac 关机或 Latch 没有运行", "unknown": "睡眠、关机或 Latch 没有运行"]
    public static func causeWords(_ cause: String) -> String { causes[cause] ?? causes["unknown"]! }
    /** The web's `whenWords`: 今天 09:00, 明天 09:00, 昨天 09:00, 11月17日 09:00, 2025年11月17日 09:00. */
    public static func when(_ date: Date, now: Date = Date()) -> String {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        let clock = PhoneTime.clock(date)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days == 0 { return "今天 " + clock }
        if days == 1 { return "明天 " + clock }
        if days == -1 { return "昨天 " + clock }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let year = parts.year == calendar.component(.year, from: now) ? "" : "\(parts.year ?? 0)年"
        return year + "\(parts.month ?? 0)月\(parts.day ?? 0)日 " + clock
    }
    /**
     * The section's words. `sleeping`: the Host announced it goes to sleep and the phone has not reached it since;
     * `reachable`: the phone reaches it now. Missed times are grouped by schedule in the Host's order.
     */
    public static func view(reachable: Bool, sleeping: Bool, read: PhoneAgentComputerRead?, keepAwakeOn: Bool, now: Date = Date()) -> PhoneComputerView {
        let computer = read?.computer
        let status: (String, PhoneTone) = sleeping ? ("睡眠中", .neutral) : !reachable ? ("不在线", .warn)
            : computer?.keepAwake != nil ? ("保持唤醒中", .done) : ("在线", .done)
        var order: [String] = [], groups: [String: (name: String, times: [String])] = [:]
        for run in read?.missed ?? [] {
            if groups[run.automationId] == nil { order.append(run.automationId); groups[run.automationId] = (run.name, []) }
            groups[run.automationId]!.times.append(when(run.at, now: now) + "：" + causeWords(run.cause))
        }
        let awake = status.0 == "保持唤醒中"
        return PhoneComputerView(status: status.0, tone: status.1,
            awakeFor: awake ? (computer?.keepAwake == "schedule" ? "定时任务快到点了" : "有会话在运行或等你处理") : nil,
            woke: computer?.wokeAt.map { when($0, now: now) }, missedTotal: read?.missed.count ?? 0,
            missed: order.map { PhoneMissedGroup(automationId: $0, name: groups[$0]!.name, times: groups[$0]!.times) },
            keepAwakeNote: keepAwakeOn && computer != nil && computer?.desktop == false ? "Latch 应用没有运行，现在不起作用" : nil)
    }
    /**
     * What the snapshot says of this owner's computer and schedules; the section reads again when it changes (a missed
     * time or a run moves `lastRun`), as the web's `computerVersion` does.
     */
    public static func signature(_ snapshot: NativeJSON, owner: String) -> String {
        let schedules = snapshot["automations"] == .null ? "-" : snapshot["automations"].array
            .filter { ($0["customAgentId"].string ?? PhoneAgents.generalId) == owner }
            .map { [$0["id"].string ?? "", "\($0["revision"].integer ?? 0)", $0["lastRun"]["at"].string ?? "", $0["lastRun"]["state"].string ?? ""].joined(separator: ":") }
            .joined(separator: ",")
        let computer = (try? snapshot["computer"].encoded()).map { String(decoding: $0, as: UTF8.self) } ?? "null"
        return computer + "|" + schedules + "|" + (snapshot["customAgents"] == .null ? "absent" : "present")
    }
    /** Only inside a content window and for a device with the full data scope: everything else shows none of it. */
    public static func shown(_ snapshot: NativeJSON, windowOpen: Bool) -> Bool { PhoneAgents.access(snapshot, windowOpen: windowOpen) == .ready }

    /* 通知 and 到点前后保持唤醒 */

    /** The Agent's switches; absent means every one is on, as before. */
    public static func notifications(_ agent: NativeJSON) -> [PhoneNotificationKind: Bool] {
        let stored = agent["notifications"]
        return Dictionary(uniqueKeysWithValues: PhoneNotificationKind.allCases.map { kind in
            (kind, stored == .null ? true : stored[kind.rawValue] == .bool(true))
        })
    }
    public static func keepAwake(_ agent: NativeJSON) -> Bool { agent["keepAwakeForSchedules"].bool }
    private static func patch(_ agent: NativeJSON, _ fields: [String: NativeJSON]) throws -> NativePendingWrite {
        guard let id = agent["id"].string, PhoneAgents.validId(id), id != PhoneAgents.generalId, let revision = agent["revision"].integer else { throw NativeFailure.invalidRecord }
        var body = fields
        body["baseRevision"] = .number(Double(revision))
        return try NativePendingWrite(method: .patch, path: "/link/api/custom-agents/" + id, fields: body)
    }
    /** One switch changed, on the revision the person saw; back to the default (null) once every one is on again. */
    public static func notificationsWrite(_ agent: NativeJSON, kind: PhoneNotificationKind, on: Bool) throws -> NativePendingWrite {
        var next = notifications(agent)
        next[kind] = on
        let all = PhoneNotificationKind.allCases.allSatisfy { next[$0] == true }
        let value: NativeJSON = all ? .null : .object(Dictionary(uniqueKeysWithValues: PhoneNotificationKind.allCases.map { ($0.rawValue, .bool(next[$0] ?? true)) }))
        return try patch(agent, ["notifications": value])
    }
    public static func keepAwakeWrite(_ agent: NativeJSON, on: Bool) throws -> NativePendingWrite {
        try patch(agent, ["keepAwakeForSchedules": .bool(on)])
    }
    /** This device's unconfirmed change of one of the Agent's fields (`notifications` or `keepAwakeForSchedules`). */
    public static func held(_ pending: [NativePendingWrite], agentId: String, field: String) -> NativePendingWrite? {
        pending.first { PhonePending.kind($0) == .agent(id: agentId) && (try? NativeJSON.decode($0.body))?.object[field] != nil }
    }
    /**
     * Whether the switches take no change now: one of them is being written, the phone's one pending write is taken (by
     * this Agent's unconfirmed change, offered again below them, or by any other write), the model is busy, or the
     * device cannot change them.
     */
    public static func switchesLocked(pending: [NativePendingWrite], working: Bool, busy: Bool, connected: Bool, canRun: Bool) -> Bool {
        working || busy || !pending.isEmpty || blocker(connected: connected, canRun: canRun) != nil
    }
    /**
     * The notification switch an unconfirmed write changes, for its spinner on a retry: the first one whose value in the
     * write differs from what the Host shows now; nil when none does (the Host already has it) or it is no such write.
     */
    public static func heldKind(_ write: NativePendingWrite, agent: NativeJSON) -> PhoneNotificationKind? {
        guard let body = try? NativeJSON.decode(write.body), let sent = body.object["notifications"] else { return nil }
        let current = notifications(agent)
        return PhoneNotificationKind.allCases.first { kind in (sent == .null ? true : sent[kind.rawValue] == .bool(true)) != current[kind] }
    }
    /** Why the switches cannot be changed here now; nil when they can. */
    public static func blocker(connected: Bool, canRun: Bool) -> String? {
        if !connected { return "Mac 不在线，恢复后再改" }
        if !canRun { return "这台设备只能查看：它没有开始会话的权限。" }
        return nil
    }
}
