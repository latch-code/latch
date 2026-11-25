import Foundation
import LatchNativeCore
import UIKit
import UserNotifications

/** One saved computer as the menu draws it. */
struct PhoneComputerRow: Identifiable {
    let host: RegisteredHost
    let name: String
    let selected: Bool
    let state: NativeComputerState?
    let lastSeen: Date?
    let waiting: Int
    var id: String { host.id }
    var line: String { PhoneComputers.menuLine(state: state, lastSeen: lastSeen, waiting: waiting) }
}

/**
 * Several computers: the selected one keeps its whole workspace; every other one is read through its own list connection
 * (`NativeListWatcher`), with its own keys and address book, only while the App is in front.
 */
extension PhoneModel {
    var otherHosts: [RegisteredHost] { hosts.filter { $0.id != selectedHost?.id && !forgettingComputers.contains($0.id) } }
    /** Names as the phone shows them: one that could pass for another carries its hostId. */
    var computerNames: [String: String] { PhoneComputers.names(hosts.map { ($0.id, $0.device.hostId, $0.name) }) }
    func computerName(_ host: RegisteredHost) -> String { computerNames[host.id] ?? host.name }
    var computerRows: [PhoneComputerRow] {
        let names = computerNames
        return hosts.map { host in
            if host.id == selectedHost?.id {
                let state: NativeComputerState = connected ? .online : offline ? .offline : .connecting
                let waiting = snapshot["tasks"].array.filter { !$0["archived"].bool && PhoneSessions.waitsOnYou($0) }.count
                return PhoneComputerRow(host: host, name: names[host.id] ?? host.name, selected: true, state: state, lastSeen: lastConfirmed, waiting: waiting)
            }
            let reading = computerReadings[host.id]
            return PhoneComputerRow(host: host, name: names[host.id] ?? host.name, selected: false, state: reading?.state, lastSeen: reading?.lastSeen,
                waiting: reading.map { PhoneComputers.attention($0.list).count } ?? 0)
        }
    }
    /** 「其他电脑」 under 等你处理. */
    var otherComputerGroups: [PhoneComputerGroup] {
        let names = computerNames
        return PhoneComputers.groups(otherHosts.map { host in
            let reading = computerReadings[host.id]
            return (host.id, names[host.id] ?? host.name, reading?.state, reading?.list ?? .null)
        })
    }
    var computerReadings: [String: NativeWatchReading] { computerDesk.readings }
    /** Starts, or restarts after a switch, the list connections to every computer but the selected one. */
    func watchOthers() {
        #if LATCH_SCREENS
        if staged { return }
        #endif
        guard store != nil else { return }
        let others = otherHosts, ids = Set(others.map(\.id))
        let token = computerDesk.watch(selected: selectedHost?.id, others: others.map(\.id))
        for (id, browser) in watchDiscoveries where !ids.contains(id) { browser.stop(); watchDiscoveries[id] = nil }
        for host in others where watchDiscoveries[host.id] == nil { watchDiscoveries[host.id] = browse(host) }
        let watcher = self.watcher ?? NativeListWatcher { [weak self] reading in Task { @MainActor in await self?.receive(reading) } }
        self.watcher = watcher
        let targets = others.map { host in
            NativeWatchTarget(id: host.id, device: host.device) { [weak self] in
                guard let self else { return [] }
                return try await self.watchCandidates(host)
            }
        }
        let previous = watchTail
        watchTail = Task { await previous?.value; await watcher.watch(targets, token: token) }
    }
    /** A new network: every list connection closes and Bonjour starts again for each computer. */
    func othersNetworkChanged() {
        guard let watcher else { return }
        for (id, browser) in watchDiscoveries {
            browser.stop()
            if let host = hosts.first(where: { $0.id == id }) { watchDiscoveries[id] = browse(host) }
        }
        let previous = watchTail
        watchTail = Task { await previous?.value; await watcher.networkChanged() }
    }
    private func browse(_ host: RegisteredHost) -> NativeDiscovery {
        let browser = NativeDiscovery()
        if let key = try? AddressBookCodec.discoveryKey(host.device.signedAddressBook, rootSpki: host.device.rootSpki, deviceId: host.device.deviceId,
            nowMs: UInt64(Date().timeIntervalSince1970 * 1000), priorGeneration: host.device.bookGeneration, priorHash: host.device.bookHash) {
            try? browser.start(key: key)
        }
        return browser
    }
    func stopWatching(forget: Bool) {
        computerDesk.stop()
        if let watcher { let previous = watchTail; watchTail = Task { await previous?.value; await watcher.close() } }
        for browser in watchDiscoveries.values { browser.stop() }
        watchDiscoveries = [:]
        if forget {
            watcher = nil; computerDesk = PhoneComputerDesk(); otherOpening = nil
            // Nothing posted stays on the lock screen or in the list once the App has gone.
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        }
    }
    /** A computer gone from this phone: its notifications go too. */
    func forgetNotices(_ host: RegisteredHost, onlyThisComputer: Bool) {
        let identifiers = PhoneComputerNotices.forget(computer: host.id)
        let center = UNUserNotificationCenter.current()
        if onlyThisComputer {
            center.removePendingNotificationRequests(withIdentifiers: identifiers)
            center.removeDeliveredNotifications(withIdentifiers: identifiers)
        } else { center.removeAllDeliveredNotifications() }
    }
    /** Bonjour for that computer's own key, a fresh pairing's LAN hints, then its own relay; never the selected computer's ways in. */
    private func watchCandidates(_ host: RegisteredHost) async throws -> [NativePathCandidate] {
        let keys = PhoneKeys.provider(host.keys)
        let result = try await directCandidates(host, browser: watchDiscoveries[host.id])
        return result + NativeListWatcher.relayCandidates(device: host.device, keys: keys)
    }
    private func receive(_ reading: NativeWatchReading) async {
        let notifying = PhoneComputerNotices.isOn && UIApplication.shared.applicationState == .active
        switch computerDesk.receive(reading, notifying: notifying) {
        case .dropped, .kept: return
        case let .notify(session):
            guard let host = hosts.first(where: { $0.id == reading.id }) else { return }
            PhoneComputerNotices.post(name: computerName(host), computer: host.id, session: session)
        case let .retire(proof):
            // The same retirement as the selected computer's: profile, keys and encrypted cache, on the Root-signed proof only.
            guard let host = hosts.first(where: { $0.id == reading.id }) else { return }
            await retire(host, proof: proof)
        }
    }
    /** A tapped notification: opened now, or once the store is open again after the App comes back. */
    func requestOther(computer: String, session: String) async {
        guard storeState == .ready, store != nil else { pendingOther = (computer, session); return }
        await openOther(computer: computer, session: session)
    }
    /** The computer menu: a plain switch, which an item of 其他电脑 still being opened gives way to. */
    func switchComputer(_ host: RegisteredHost) async {
        otherOpening = nil
        if selectedHost?.id != host.id { await connect(host) }
    }
    /** An item of 其他电脑, or a notification: switch to that computer, then open the session once it is ready there. */
    func openOther(computer id: String, session: String?) async {
        guard let host = hosts.first(where: { $0.id == id }) else { return }
        let opening = UUID(); otherOpening = opening
        tab = .code
        if selectedHost?.id != id { await connect(host) }
        guard otherOpening == opening, selectedHost?.id == id, connected, let session,
              snapshot["tasks"].array.contains(where: { $0["id"].string == session }) else { return }
        otherOpening = nil
        await openSession(session)
    }
}

/** 「其他电脑等你处理时通知」: off by default, only while the App is in front, never a session's title. */
@MainActor enum PhoneComputerNotices {
    static let key = "LatchNotifyOtherComputers"
    static var isOn: Bool { UserDefaults.standard.bool(forKey: key) }
    /** Where each posted notification leads, in this process only; the notification itself carries a random ID. */
    private static var targets = PhoneNoticeTargets()
    static func change(to next: Bool) async -> Bool {
        guard next else { UserDefaults.standard.set(false, forKey: key); return true }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
        UserDefaults.standard.set(granted, forKey: key)
        return granted
    }
    static func post(name: String, computer: String, session: String) {
        let id = targets.add(computer: computer, session: session)
        let content = UNMutableNotificationContent()
        content.body = PhoneComputers.notificationBody(name)
        content.sound = .default
        content.threadIdentifier = "other-computers"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
    static func target(_ id: String) -> (computer: String, session: String)? { targets.take(id) }
    static func forget(computer: String) -> [String] { targets.forget(computer: computer) }
}

extension Notification.Name {
    static let latchOpenOther = Notification.Name("app.latch.open-other-computer")
}

/** Shows the notification while the App is in front (the only time one is sent) and turns a tap into a switch and open. */
final class PhoneNoticeDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if response.notification.request.trigger is UNPushNotificationTrigger {
            let info = response.notification.request.content.userInfo
            if let route = info["route"] as? String, let ticket = info["ticket"] as? String, let hint = PhonePushHint(route: route, ticket: ticket, reject: response.actionIdentifier == "latch.review-rejection") {
                await PhonePush.shared.visit(hint)
            }
            return
        }
        let id = response.notification.request.identifier
        await MainActor.run {
            guard let target = PhoneComputerNotices.target(id) else { return }
            NotificationCenter.default.post(name: .latchOpenOther, object: nil, userInfo: ["computer": target.computer, "session": target.session])
        }
    }
}
