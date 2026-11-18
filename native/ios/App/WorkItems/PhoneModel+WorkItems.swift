import Foundation
import LatchNativeCore

/** Only identities go on the navigation stack. Each page's content is read again in its own window. */
enum PhoneWorkDestination: Hashable {
    case source(PhoneWorkSource)
    case session(String)
    case reply(post: String, message: String, source: PhoneWorkSource)
    case review(session: String, turn: String?)
    case evidence(session: String)
    case commit(session: String, sha: String)
    case commitFile(session: String, sha: String, path: String)
    case pullRequest(session: String, number: UInt64)
    case checkLog(session: String, number: UInt64, sha: String, job: String)

    var openedSession: String? {
        switch self {
        case let .source(source): source.sessionId
        case let .session(id): id
        default: nil
        }
    }

    var sourceSession: String {
        switch self {
        case let .source(source), let .reply(_, _, source): source.sessionId
        case let .session(id), let .review(id, _), let .evidence(id), let .commit(id, _),
             let .commitFile(id, _, _), let .pullRequest(id, _), let .checkLog(id, _, _, _): id
        }
    }

    var requiresMember: Bool {
        switch self {
        case .evidence, .commit, .commitFile, .pullRequest, .checkLog, .review(_, nil): true
        default: false
        }
    }
}

struct PhoneWorkDecisionContext {
    let itemId: String
    let source: PhoneWorkSource
    let stamp: PhoneWorkReadStamp
    let navigation: UUID
}

extension PhoneModel {
    var offersWorkItems: Bool {
        PhoneWorkItems.supported(snapshot) && hasScope("view") && snapshot["device"]["status"].string == "active"
    }
    var mayReadPrivateWork: Bool {
        connected && workTransportReady && hasContentWindow && privateSnapshot.confirmed && snapshot["device"]["dataScope"].string == "all"
    }
    private var workTransportReady: Bool {
        #if LATCH_SCREENS
        if staged { return true }
        #endif
        return installedTransport?.valid == true
    }
    var workItems: [PhoneWorkItemSummary] {
        guard offersWorkItems else { return [] }
        return PhoneWorkItems.visible(snapshot, privateAllowed: mayReadPrivateWork)
    }
    func workItem(_ id: String) -> PhoneWorkItemSummary? {
        guard offersWorkItems, let value = snapshot["items"].array.prefix(2000).first(where: { $0["id"].string == id }),
              let item = PhoneWorkItemSummary(value), !item.isPrivate || mayReadPrivateWork else { return nil }
        return item
    }

    func showWorkItems(_ show: Bool) {
        guard show != workItemsShown, !show || offersWorkItems else { return }
        if show {
            if sessionId != nil { closeSession() }
            reviewTarget = nil
        } else { selectWorkItem(nil) }
        workItemsShown = show
    }

    func selectWorkItem(_ id: String?) {
        guard id == nil || (offersWorkItems && id.flatMap(workItem) != nil), id != workItemId else { return }
        setWorkPath([])
        workSelection = UUID()
        workItemId = id
    }

    func setWorkPath(_ next: [PhoneWorkDestination]) {
        let previous = workPath.reversed().compactMap(\.openedSession).first
        workPath = next
        if let previous, sessionId == previous, !next.contains(where: { $0.openedSession == previous }) { closeSession() }
    }

    func withdrawWorkSessionBody() -> Bool {
        guard let sessionId, workPath.contains(where: { $0.openedSession == sessionId }) else { return false }
        detail = .null; detailFailed = nil; contentGeneration = UUID()
        cancelPreview(); PreviewFiles.clear()
        return true
    }

    func clearWorkContent() {
        if withdrawWorkSessionBody() { sessionId = nil }
        workPath = []
    }

    func withdrawDisconnectedWork() {
        // An unchanged network interface and a still-valid lease are not a fresh WorkItem projection.
        workConnection = UUID()
        clearWorkContent()
        if PhoneWorkItems.supported(snapshot) { snapshot = PhoneWorkItems.withoutBody(snapshot) }
    }

    func workSourceVisibility(_ id: String) -> PhoneWorkSourceVisibility {
        PhoneWorkItems.sourceVisibility(snapshot, sessionId: id)
    }

    func workDestinationAllowed(_ destination: PhoneWorkDestination, itemId: String) -> Bool {
        guard let item = workItem(itemId), workSourceVisibility(destination.sourceSession) == .readable else { return false }
        return !destination.requiresMember || item.sessionIds.contains(destination.sourceSession)
    }

    func reconcileWorkSources(_ previous: [NativeJSON]) {
        guard workItemsShown, let itemId = workItemId else { return }
        let visible = Set(snapshot["tasks"].array.compactMap { $0["id"].string })
        // Withdraw candidates even if a subsequent checkpoint restores the source before SwiftUI next draws.
        if previous.contains(where: { $0["id"].string.map { !visible.contains($0) } == true }) { workSelection = UUID() }
        let kept = Array(workPath.prefix { workDestinationAllowed($0, itemId: itemId) })
        if kept != workPath { setWorkPath(kept) }
    }

    func resetWorkItems() {
        clearWorkContent()
        workItemId = nil; workItemsShown = false; workSelection = UUID()
    }

    /** Opening the window is a separate intent. Content reads never sign or reopen it. */
    func openWorkWindow() async {
        guard tab == .code, workItemsShown, offersWorkItems, connected, workTransportReady, !verifying else { return }
        #if LATCH_SCREENS
        if staged { ScreensStage.openWorkWindow(self); return }
        #endif
        let host = generation, selection = workSelection, connection = workConnection, transport = installedTransport
        func current() -> Bool {
            !Task.isCancelled && host == generation && selection == workSelection && connection == workConnection
                && installedTransport === transport && workTransportReady && connected && tab == .code && workItemsShown
        }
        do {
            try await ensureVerified()
            guard current() else { return }
            await refresh()
        } catch {
            guard current() else { return }
            if (error as? NativeFailure) != .declined, !wentAway(error) { report(error) }
        }
    }

    func workStamp(_ itemId: String) -> PhoneWorkReadStamp? {
        guard tab == .code, workItemsShown, workItemId == itemId, workItem(itemId) != nil, workTransportReady else { return nil }
        return PhoneWorkReadStamp(connected: connected, host: generation, connection: workConnection, transport: installedTransport,
            network: networkGeneration, window: hasContentWindow ? privateSnapshot.epoch : nil, selection: workSelection, instance: snapshot["instanceId"].string)
    }

    @discardableResult func publishWork(_ stamp: PhoneWorkReadStamp, itemId: String, _ apply: () -> Void) -> Bool {
        func publish() -> Bool {
            guard !Task.isCancelled, stamp == workStamp(itemId) else { return false }
            apply()
            return true
        }
        if let transport = stamp.transport { return transport.whileCurrent(publish) == true }
        #if LATCH_SCREENS
        if staged { return publish() }
        #endif
        return false
    }

    func readWork(_ read: PhoneWorkRead, itemId: String, stamp: PhoneWorkReadStamp, destination: PhoneWorkDestination? = nil) async throws -> NativeJSON {
        let navigation = workPathGeneration
        func current() -> Bool {
            guard !Task.isCancelled, stamp == workStamp(itemId),
                  read.sessionIds.allSatisfy({ workSourceVisibility($0) == .readable }) else { return false }
            if let destination {
                return navigation == workPathGeneration && workPath.last == destination && workDestinationAllowed(destination, itemId: itemId)
            }
            return true
        }
        guard current() else { throw CancellationError() }
        #if LATCH_SCREENS
        if staged { return try ScreensStage.workRead(read) }
        #endif
        guard let workspace, let transport = stamp.transport else { throw NativeFailure.unavailable }
        do {
            let value = try await workspace.readWork(read, on: transport)
            guard current() else { throw CancellationError() }
            return value
        } catch {
            guard current() else { throw CancellationError() }
            if (error as? NativeFailure) == .expired { report(error) }
            else if (error as? NativeReadFailure) == .bodyAccessChanged || (error as? NativeFailure) == .forbidden {
                // A newer access checkpoint or refusal must withdraw already painted content too.
                withdrawWorkContent()
            } else if (error as? PhoneWorkReadFailure) == .itemMissing {
                selectWorkItem(nil)
                withdrawWorkContent()
            } else { _ = wentAway(error) }
            throw error
        }
    }

    func openWorkSession(_ id: String, itemId: String, destination: PhoneWorkDestination, again: Bool = false) async {
        guard workStamp(itemId) != nil, workPath.last == destination, destination.openedSession == id,
              workDestinationAllowed(destination, itemId: itemId) else { return }
        guard again || sessionId != id || detail["summary"]["id"].string != id else { return }
        #if LATCH_SCREENS
        if staged { ScreensStage.openWorkSession(id, model: self); return }
        #endif
        await openSession(id)
    }

    /** An exact decision can become stale while a sheet closes or a queued control waits. */
    func permitsWorkDecision(_ context: PhoneWorkDecisionContext?) -> Bool {
        guard let context else { return true }
        return connected && !detailCached && sessionId == context.source.sessionId && workStamp(context.itemId) == context.stamp
            && workPathGeneration == context.navigation && workPath.last == .source(context.source)
            && workDestinationAllowed(.source(context.source), itemId: context.itemId) && context.source.currentDecision(detail: detail, summary: currentSummary) != nil
    }
}
