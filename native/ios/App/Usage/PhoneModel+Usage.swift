import Foundation
import LatchNativeCore

extension PhoneModel {
    /** The Host keeps the record 用量 reads; without it the sheet shows 额度 alone, as the desktop does. */
    var usageOffered: Bool { snapshot["catalog"]["features"]["modelUsage"].bool }

    /**
     * Looking at 额度 asks the Host to read the limits again. It needs `run` and an open window, and is skipped silently
     * without them: what the Host reads arrives with the catalog, so nothing waits on the answer.
     */
    func refreshQuota(retry: Bool = false) async {
        #if LATCH_SCREENS
        if staged { return }
        #endif
        guard canRun, hasContentWindow, let workspace, let transport = installedTransport, transport.valid else { return }
        try? await workspace.refreshQuota(retry: retry)
    }

    /** One read of 用量 inside the open window; a late answer from another connection or window is dropped. */
    func readUsage(period: String, group: String) async throws -> PhoneUsageSummary {
        let value: NativeJSON
        #if LATCH_SCREENS
        if staged {
            value = try ScreensStage.usage(period: period, group: group)
            guard let summary = PhoneUsage.summary(value, catalog: snapshot["catalog"]) else { throw NativeFailure.invalidRecord }
            return summary
        }
        #endif
        guard let workspace, let transport = installedTransport, transport.valid else { throw NativeFailure.unavailable }
        guard hasContentWindow, let lease = bodyLease else { throw NativeFailure.expired }
        let current = generation
        value = try await workspace.usageSummary(period: period, group: group)
        guard current == generation, installedTransport === transport, transport.valid, bodyLease?.sameWindow(as: lease) == true,
              !Task.isCancelled else { throw CancellationError() }
        guard let summary = PhoneUsage.summary(value, catalog: snapshot["catalog"]) else { throw NativeFailure.invalidRecord }
        return summary
    }

    /** 「查看用量」: opens the content window only because the person asked. */
    func openUsageWindow() async {
        do { try await ensureVerified() } catch {
            guard !(error is CancellationError), (error as? NativeFailure) != .declined, !wentAway(error) else { return }
            report(error)
        }
    }
}
