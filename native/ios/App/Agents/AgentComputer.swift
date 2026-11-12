import LatchNativeCore
import SwiftUI

/**
 * 「电脑」 of an Agent's profile, as the Host recorded it: online, asleep or kept awake; when it last woke; the times its
 * schedules missed since each last ran, with 立即运行; and, for one of 我的 Agent with schedules, 「到点前后保持唤醒」.
 * Shown only inside a content window on a device with the full data scope, like the rest of the profile.
 */
struct ComputerSection: View {
    @EnvironmentObject private var model: PhoneModel
    let id: String
    /** The Agent's summary from the snapshot; null for 通用, which has no switch of its own. */
    let agent: NativeJSON
    @State private var read = PhoneAgentRead.loading
    @State private var reading = UUID()
    @State private var states: [String: PhoneAgentWrite] = [:]
    @State private var working: Set<String> = []
    private var windowOpen: Bool { model.verifiedUntil != nil }
    private var value: PhoneAgentComputerRead? { if case let .ready(json) = read { return PhoneAgentComputer.parse(json) }; return nil }
    private var schedulesOn: Bool { model.snapshot["catalog"]["features"]["automations"].bool }
    var body: some View {
        let view = PhoneAgentComputer.view(reachable: model.connected, sleeping: model.hostNotice?.state == "sleeping", read: value,
            keepAwakeOn: PhoneAgentComputer.keepAwake(agent))
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "laptopcomputer").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted)
                    Text(model.selectedHost.map(model.computerName) ?? "Mac").font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                    Spacer(minLength: 4)
                    ToneWord(word: view.status, tone: view.tone)
                    if let why = view.awakeFor { HintButton(label: "为什么保持唤醒", text: why) }
                }
                if let woke = view.woke { Text("上次唤醒 " + woke).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                switch read {
                case .loading: if value == nil { ProgressView().controlSize(.small).tint(PhoneTheme.muted) }
                case .ready: EmptyView()
                case .offline, .closed, .locked, .confirming: EmptyView()
                default:
                    HStack {
                        Label("读取失败", systemImage: "exclamationmark.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.red)
                        Spacer()
                        Button("重试") { reading = UUID() }.font(PhoneTheme.caption)
                    }
                }
                if view.missedTotal > 0 { missed(view) }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(PhoneTheme.line))
            .accessibilityElement(children: .contain).accessibilityLabel("电脑")
            if agent != .null && schedulesOn { keepAwake(note: view.keepAwakeNote) }
        }
        .task(id: [PhoneAgentComputer.signature(model.snapshot, owner: id), windowOpen ? "open" : "closed", reading.uuidString]) {
            guard PhoneAgentComputer.shown(model.snapshot, windowOpen: windowOpen) else { read = .closed; return }
            // A reread keeps what is shown until the answer comes.
            if value == nil { read = .loading }
            let next = await model.readComputer(id)
            // A newer read (立即运行, a snapshot change) replaced this one: what is shown stays until it answers.
            if next != .loading, !Task.isCancelled { read = next }
        }
        // What the window showed goes with it.
        .onChange(of: model.contentGeneration) { _, _ in if !windowOpen { read = .closed } }
    }
    private func missed(_ view: PhoneComputerView) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(PhoneTheme.amberIcon)
                Text("错过 \(view.missedTotal) 次").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.amber)
                HintButton(label: "错过的时间", text: "Mac 睡眠、关机或 Latch 没有运行时，定时任务不会运行，醒来后也不补跑。")
            }
            ForEach(view.missed) { group in missedRow(group) }
        }
        .padding(.top, 4)
        .accessibilityElement(children: .contain).accessibilityLabel("错过的定时")
    }
    private func missedRow(_ group: PhoneMissedGroup) -> some View {
        let key = "run:" + group.automationId
        let held = PhoneResults.heldRun(model.pending, automationId: group.automationId)
        let block = PhoneScheduleWrite.blocker(agent: agent, connected: model.connected, canRun: model.canRun)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.name).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                    ForEach(group.times, id: \.self) { Text($0).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                }
                Spacer(minLength: 4)
                if model.canRun && held == nil {
                    Button { if let write = try? PhoneResults.runNow(automationId: group.automationId) { send(key, write) } } label: {
                        ZStack { Label("立即运行", systemImage: "play.fill").opacity(working.contains(key) ? 0 : 1); if working.contains(key) { ProgressView().controlSize(.mini) } }
                    }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink)
                    .disabled(working.contains(key) || model.busy || !model.pending.isEmpty || block != nil)
                }
            }
            if let block, model.canRun { Text(block).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(2) }
            if let held, !working.contains(key) { WriteNotice(state: .unknown, retry: { send(key, held) }, held: held) }
            else if let state = states[key] { WriteNotice(state: state, reload: { states[key] = nil; Task { await model.refresh() } }) }
        }
    }
    private func keepAwake(note: String?) -> some View {
        let key = "keep-awake"
        let held = PhoneAgentComputer.held(model.pending, agentId: id, field: "keepAwakeForSchedules")
        return VStack(alignment: .leading, spacing: 4) {
            switchRow("到点前后保持唤醒", on: PhoneAgentComputer.keepAwake(agent), key: key, held: held) { on in try PhoneAgentComputer.keepAwakeWrite(agent, on: on) }
            HStack(spacing: 4) {
                Text(note ?? "Latch 应用运行时有效").font(PhoneTheme.caption).foregroundStyle(note == nil ? PhoneTheme.muted : PhoneTheme.amber)
                HintButton(label: "到点前后保持唤醒", text: "从这个 Agent 的定时任务前 2 分钟起不让这台 Mac 闲置睡眠，直到这次运行结束，最长 32 分钟。已经睡眠或合上盖子的 Mac 不会被唤醒，也不改系统的唤醒计划。")
            }
            notice(key, held: held)
        }
    }
    /** A switch showing the Host's state: it changes only when the Host answers, through the phone's one pending write. */
    fileprivate func switchRow(_ title: String, on: Bool, key: String, held: NativePendingWrite?, make: @escaping (Bool) throws -> NativePendingWrite) -> some View {
        AgentSwitch(title: title, on: on, working: working.contains(key), locked: switchLocked(held: held)) { next in
            if let write = try? make(next) { send(key, write) }
        }
    }
    private func switchLocked(held: NativePendingWrite?) -> Bool {
        PhoneAgentComputer.switchesLocked(pending: model.pending, working: !working.isEmpty, busy: model.busy, connected: model.connected, canRun: model.canRun)
    }
    @ViewBuilder private func notice(_ key: String, held: NativePendingWrite?) -> some View {
        if let held, !working.contains(key) { WriteNotice(state: .unknown, retry: { send(key, held) }, held: held) }
        else if let state = states[key] { WriteNotice(state: state, reload: { states[key] = nil; Task { await model.refresh() } }) }
    }
    private func send(_ key: String, _ write: NativePendingWrite) {
        working.insert(key); states[key] = nil
        Task {
            let outcome = await model.writeAgent(write)
            working.remove(key)
            // Unknown stays with the model's pending write, which the row offers again.
            if outcome != .done && outcome != .unknown { states[key] = outcome }
            if outcome == .done { reading = UUID() }
        }
    }
}

/**
 * 通知: which of this Agent's notifications the Latch app on the Mac sends for its topics and scheduled runs. The phone's
 * own notifications do not follow them; that is said behind ⓘ.
 */
struct NotificationSection: View {
    @EnvironmentObject private var model: PhoneModel
    let agent: NativeJSON
    @State private var state: PhoneAgentWrite?
    @State private var working: PhoneNotificationKind?
    @State private var sending = false
    private var id: String { agent["id"].string ?? "" }
    var body: some View {
        let current = PhoneAgentComputer.notifications(agent)
        let held = PhoneAgentComputer.held(model.pending, agentId: id, field: "notifications")
        let locked = PhoneAgentComputer.switchesLocked(pending: model.pending, working: sending, busy: model.busy, connected: model.connected, canRun: model.canRun)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text("Mac 上的 Latch 应用").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                HintButton(label: "通知", text: "这个 Agent 的话题和定时运行完成、失败或等你处理时，Mac 上的 Latch 应用按这里发通知。这台 iPhone 或 iPad 的通知不分 Agent，不受这些开关影响。")
            }
            ForEach(PhoneNotificationKind.allCases, id: \.self) { kind in
                AgentSwitch(title: kind.label, on: current[kind] ?? true, working: working == kind, locked: locked) { on in
                    if let write = try? PhoneAgentComputer.notificationsWrite(agent, kind: kind, on: on) { send(kind, write) }
                }
            }
            if !model.canRun { Text("这台设备只能查看：它没有开始会话的权限。").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            if let held, !sending { WriteNotice(state: .unknown, retry: { send(PhoneAgentComputer.heldKind(held, agent: agent), held) }, held: held) }
            else if let state { WriteNotice(state: state, reload: { self.state = nil; Task { await model.refresh() } }) }
        }
        .accessibilityElement(children: .contain).accessibilityLabel("通知")
    }
    /** `kind`: the switch whose row spins; a retry the Host already answers spins none, yet still locks them all. */
    private func send(_ kind: PhoneNotificationKind?, _ write: NativePendingWrite) {
        working = kind; sending = true; state = nil
        Task {
            let outcome = await model.writeAgent(write)
            working = nil; sending = false
            if outcome != .done && outcome != .unknown { state = outcome }
        }
    }
}

/** One switch row: the Host's value, a spinner while its write runs. */
struct AgentSwitch: View {
    let title: String
    let on: Bool
    let working: Bool
    let locked: Bool
    let change: (Bool) -> Void
    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink)
            Spacer(minLength: 4)
            if working { ProgressView().controlSize(.small) }
            Toggle(title, isOn: Binding(get: { on }, set: { change($0) })).labelsHidden().tint(PhoneTheme.accent).disabled(locked)
        }.padding(.vertical, 2)
    }
}
