import ActivityKit
import CryptoKit
import LatchNativeCore
import SwiftUI
import UIKit
import UserNotifications

/** Apple tokens stay in memory. Preferences contain only opaque routing handles for the computers opted in on this device. */
@MainActor final class PhonePush: ObservableObject {
    static let shared = PhonePush()
    private typealias Live = Activity<LatchQuestionAttributes>
    @Published var hint: PhonePushHint?
    @Published var message: String?
    @Published private(set) var revision = 0
    @Published private(set) var changing = false
    private(set) var token: Data?
    private var start: Data?
    private var startUpdates: Task<Void, Never>?
    private var activityUpdates: Task<Void, Never>?
    private var tokenUpdates: [String: Task<Void, Never>] = [:]
    private var acknowledged: [String: String] = [:]
    private var updating = false
    private var opening = false
    private var retryAfter: Date = .distantPast
    private static let preferences = "LatchBackgroundAttentionRoutes"
    private var routes: [String: String] { UserDefaults.standard.dictionary(forKey: Self.preferences) as? [String: String] ?? [:] }
    private func key(_ host: RegisteredHost) -> String { LinkBytes.hex(Data(SHA256.hash(data: Data(host.id.utf8)))) }
    func route(_ host: RegisteredHost?) -> String? { host.flatMap { routes[key($0)] } }
    private func remember(_ route: String?, for host: RegisteredHost) {
        var values = routes; values[key(host)] = route
        UserDefaults.standard.set(values, forKey: Self.preferences)
        revision += 1
    }
    private func changed() { revision += 1 }
    func received(_ value: Data) {
        guard (16...256).contains(value.count), value != token else { return }
        token = value; changed()
    }
    func failed() { message = "无法登记 Apple 推送，请检查通知权限和 App 签名后重试。" }
    static let approvalCategory = "latch.pending.approval"
    static let declineAction = "latch.review-rejection"
    func launch() {
        let actions = [
            UNNotificationAction(identifier: "latch.review-approval", title: "批准", options: [.foreground, .authenticationRequired]),
            UNNotificationAction(identifier: Self.declineAction, title: "拒绝", options: [.foreground, .authenticationRequired])
        ]
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: Self.approvalCategory, actions: actions, intentIdentifiers: [], options: [])
        ])
        guard !routes.isEmpty else { return }
        UIApplication.shared.registerForRemoteNotifications()
        listen()
    }
    private func listen() {
        if #available(iOS 17.2, *), startUpdates == nil {
            startUpdates = Task {
                for await next in Live.pushToStartTokenUpdates where self.start != next { self.start = next; self.changed() }
            }
        }
        if activityUpdates == nil {
            for activity in Live.activities { observe(activity) }
            activityUpdates = Task { for await activity in Live.activityUpdates { observe(activity) } }
        }
    }
    private func observe(_ activity: Live) {
        guard activity.attributes.route != nil, tokenUpdates[activity.id] == nil else { return }
        tokenUpdates[activity.id] = Task {
            for await _ in activity.pushTokenUpdates { changed() }
            tokenUpdates.removeValue(forKey: activity.id)
        }
    }
    func toggle(_ next: Bool, model: PhoneModel) async {
        guard !changing, let host = model.selectedHost, let workspace = model.workspace, model.connected else { return }
        changing = true; defer { changing = false }
        do {
            try await model.ensureVerified(whileCurrent: { model.selectedHost?.id == host.id })
            if next {
                let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                guard granted else { message = "请在系统设置中允许 Latch 通知。"; return }
                guard model.selectedHost?.id == host.id, model.workspace === workspace else { return }
                remember(route(host) ?? UUID().uuidString.lowercased(), for: host)
                retryAfter = .distantPast
                UIApplication.shared.registerForRemoteNotifications(); listen()
                await sync(model)
            } else {
                try await workspace.setAttentionSubscription(.object(["disabled": .bool(true)]))
                let previous = route(host)
                acknowledged.removeValue(forKey: host.id)
                remember(nil, for: host)
                if let previous {
                    ApprovalSessionPreview.remove(route: previous)
                    for activity in Live.activities where activity.attributes.route == previous { await activity.end(nil, dismissalPolicy: .immediate) }
                }
            }
        } catch { message = "电脑没有确认通知设置，请连接后重试。" }
    }
    func forget(_ host: RegisteredHost) {
        guard let old = route(host) else { return }
        ApprovalSessionPreview.remove(route: old)
        remember(nil, for: host)
        acknowledged.removeValue(forKey: host.id)
        if hint?.route == old { hint = nil }
        for activity in Live.activities where activity.attributes.route == old {
            let activityId = activity.id
            Task { await Self.end(activityId) }
        }
    }
    private nonisolated static func end(_ id: String) async {
        await Activity<LatchQuestionAttributes>.activities.first { $0.id == id }?.end(nil, dismissalPolicy: .immediate)
    }
    func confirmed(_ host: RegisteredHost?) -> Bool { host.flatMap { acknowledged[$0.id] } != nil }
    func sync(_ model: PhoneModel) async {
        guard Date() >= retryAfter, !updating, !opening, model.connected, model.hasContentWindow, UIApplication.shared.applicationState == .active,
              let host = model.selectedHost, let route = route(host), let workspace = model.workspace, let token,
              model.snapshot["host"]["native"]["attentionPush"].bool else { return }
        updating = true; defer { updating = false }
        let device = LinkBytes.hex(token), liveStart = ActivityAuthorizationInfo().areActivitiesEnabled ? start.map(LinkBytes.hex) : nil
        let previewKey = liveStart != nil && model.snapshot["host"]["native"]["attentionPreview"].bool
            ? ApprovalSessionPreview.key(route: route, create: true) : nil
        let previewSignature = previewKey.map { LinkBytes.hex(Data(SHA256.hash(data: $0))) } ?? ""
        let signature = device + "-" + (liveStart ?? "") + "-" + previewSignature
        do {
            if acknowledged[host.id] != signature {
                var value: [String: NativeJSON] = ["route": .string(route), "token": .string(device)]
                if let liveStart { value["start"] = .string(liveStart) }
                if let previewKey { value["previewKey"] = .string(previewKey.base64EncodedString()) }
                try await workspace.setAttentionSubscription(.object(value))
                guard self.route(host) == route, model.workspace === workspace else { return }
                acknowledged[host.id] = signature
                changed()
            }
            for item in Live.activities where item.attributes.route == route {
                guard let ticket = item.attributes.ticket, let update = item.pushToken,
                      let hint = PhonePushHint(route: route, ticket: ticket) else { continue }
                let marker = item.id + "." + LinkBytes.hex(update)
                if acknowledged[item.id] == marker { continue }
                if try await workspace.attentionTarget(hint) == nil {
                    await item.end(nil, dismissalPolicy: .immediate); continue
                }
                try await workspace.setAttentionSubscription(.object(["route": .string(route), "ticket": .string(ticket), "update": .string(LinkBytes.hex(update))]))
                acknowledged[item.id] = marker
            }
        } catch {
            if model.connected && model.hasContentWindow && model.workspace === workspace {
                retryAfter = Date().addingTimeInterval(30)
                if changing { message = "通知登记尚未得到电脑确认，打开通知设置可重试。" }
            }
        }
    }
    func visit(_ hint: PhonePushHint) {
        // iOS can deliver the tap before protected storage and the registered computers are available.
        self.hint = hint; changed()
    }
    func open(_ model: PhoneModel) async {
        guard !opening, let hint, UIApplication.shared.applicationState == .active,
              UIApplication.shared.isProtectedDataAvailable, model.storeState == .ready else { return }
        guard let host = model.hosts.first(where: { route($0) == hint.route }) else { self.hint = nil; return }
        opening = true
        defer { opening = false; if let next = self.hint, next != hint { changed() } }
        if model.selectedHost?.id != host.id { await model.switchComputer(host) }
        guard self.hint == hint, model.connected, model.selectedHost?.id == host.id, let workspace = model.workspace else { return }
        do {
            try await model.ensureVerified(whileCurrent: { self.hint == hint && model.workspace === workspace })
            _ = await model.refresh(includeSelectedBody: false)
            let target = try await workspace.attentionTarget(hint)
            guard self.hint == hint, route(host) == hint.route, model.workspace === workspace, model.hasContentWindow else { return }
            self.hint = nil
            guard let target, let row = model.snapshot["tasks"].array.first(where: { $0["id"].string == target.session }) else {
                message = "这条审批或提问已处理，或这台设备已无法查看。"; return
            }
            model.showWorkItems(false); model.reviewTarget = nil
            if PhoneSpaces.split(model.snapshot), let owner = PhoneAgentChat.owner(row) {
                model.tab = .agents; model.agentPath = [owner]; model.questionTopic = target.session
            } else { model.tab = .code }
            await model.openSession(target.session)
            guard self.hint == nil, model.workspace === workspace, model.sessionId == target.session, model.hasContentWindow, !model.detailCached,
                  target.record(in: model.detail) != nil else {
                message = "这条审批或提问的状态已变化，请查看电脑的最新状态。"; return
            }
            model.pushFocus = (target, hint.reject)
        } catch {
            if self.hint == hint { self.hint = nil; message = "暂时无法从电脑核对这条提醒，请重连后再打开。" }
        }
    }
}
