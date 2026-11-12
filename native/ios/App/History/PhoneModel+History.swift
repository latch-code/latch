import Foundation
import LatchNativeCore

/** How a listing or preview read ended: the Host's refusal in its own code, or any other failure in words. */
enum PhoneHistoryReadFailure: Error {
    case refused(NativeHostRefusal)
    case failed(String)
}

extension PhoneModel {
    /** 接入已有会话's listing or preview, inside the window; nothing of it is stored. */
    func historyRead(_ request: PhoneHistoryRead) async throws -> NativeJSON {
        #if LATCH_SCREENS
        if staged { return try ScreensStage.history(request) }
        #endif
        guard let workspace else { throw PhoneHistoryReadFailure.failed(NativeFailure.unavailable.localizedDescription) }
        let current = generation
        do {
            guard canRun else { throw NativeFailure.forbidden }
            try await ensureVerified()
            let value = try await workspace.historyRead(request)
            guard current == generation else {
                if let id = PhoneHistory.preview(value)?.previewId { closeHistoryPreview(id) }
                throw NativeFailure.unavailable
            }
            return value
        } catch let dropped as NativeDroppedPreview {
            closeHistoryPreview(dropped.previewId)
            throw PhoneHistoryReadFailure.failed(NativeFailure.unavailable.localizedDescription)
        } catch let refusal as NativeHostRefusal {
            throw PhoneHistoryReadFailure.refused(refusal)
        } catch {
            if (error as? NativeFailure) == .expired { report(error) }
            throw PhoneHistoryReadFailure.failed(error.localizedDescription)
        }
    }
    /**
     * Lets the Host close the session a preview holds open: now when a window is open, else with the next one. Never a
     * preview an unanswered import still names.
     */
    func closeHistoryPreview(_ previewId: String) {
        #if LATCH_SCREENS
        if staged { return }
        #endif
        historyCloser.close(previewId, pending: pending)
        flushHistoryCloses()
    }
    func flushHistoryCloses() {
        guard let workspace else { return }
        let current = generation
        for id in historyCloser.take(windowOpen: verifiedUntil != nil, pending: pending) {
            Task {
                do { try await workspace.closeHistoryPreview(id) }
                catch NativeFailure.expired, NativeFailure.unavailable { if generation == current { historyCloser.requeue(id) } }
                catch {}
            }
        }
    }
    /**
     * 接入 or 按文字重建: one write kept with its request ID. An unanswered one is sent again exactly as it was; the Host
     * answers a retry from its receipt, and `history-already-imported` opens the session it names. `retry` says whether
     * this write had gone out before without an answer.
     */
    func importHistory(_ request: NativePendingWrite) async -> (outcome: PhoneWriteOutcome, retry: Bool) {
        #if LATCH_SCREENS
        if staged { return (.unknown(nil), false) }
        #endif
        let retry = pending.contains { $0.requestId == request.requestId }
        return (await write(request, timeout: PhoneHistory.importTimeout, retryAnswered: PhoneHistory.retryAnswered(request)), retry)
    }
    /**
     * 核对并放下 for an unanswered import: the Host's receipt decides. Done drops the write and names the session for the
     * caller to open (under a cover it opens once the cover has gone); no receipt drops it (nothing was brought in);
     * accepted or under way keeps it. Nil words: nothing could be checked.
     */
    /// `release`: close the preview the write held once it is settled; the preview page on screen keeps its own.
    func checkImport(_ request: NativePendingWrite, release: Bool = true) async -> (words: String?, taskId: String?) {
        guard let workspace, pending.contains(where: { $0.requestId == request.requestId }), !busy else { return (nil, nil) }
        let current = generation
        busy = true
        let receipt: PhoneImportReceipt
        do { try await ensureVerified(); receipt = try await workspace.historyReceipt(request) }
        catch { if generation == current { busy = false }; return (nil, nil) }
        guard generation == current else { return (nil, nil) }
        busy = false
        switch receipt {
        case .pending: return ("电脑上还在接入，稍后再核对", nil)
        case .none: return (await settleImport(request, release: release) ? PhoneHistory.notDoneWords : nil, nil)
        // The Host closed the preview as it brought the session in.
        case let .done(taskId): return await settleImport(request, release: false) ? ("已接入", taskId) : (nil, nil)
        }
    }
    /** The pending bar's check: there is no cover over the list, so a session brought in opens at once. */
    func checkImportFromList(_ request: NativePendingWrite) async -> String? {
        let (words, taskId) = await checkImport(request)
        if let taskId { await openImported(taskId) }
        return words
    }
    /** The write is gone without a session of its own to show: let go of the preview it held. */
    private func settleImport(_ request: NativePendingWrite, release: Bool) async -> Bool {
        guard let workspace else { return false }
        do { try await workspace.settlePending(request.requestId) } catch { return false }
        pending.removeAll { $0.requestId == request.requestId }
        if release { releaseImportPreview(request) } else { flushHistoryCloses() }
        return true
    }
    /** An import that left the queue without the Host closing its preview (refused, settled, checked): close it. */
    func releaseImportPreview(_ request: NativePendingWrite) {
        if let id = PhoneHistory.previewOf(request) { closeHistoryPreview(id) } else { flushHistoryCloses() }
    }
    /** The session a closing sheet or cover brought in, now that nothing covers the list. */
    func openPendingImport() {
        guard let taskId = openAfterDismiss else { return }
        openAfterDismiss = nil
        Task { await openImported(taskId) }
    }
    /** Opens a session brought in now or before, once the list has it. */
    func openImported(_ taskId: String) async {
        lostSessions.remove(taskId)
        await refresh()
        tab = .code
        await openSession(taskId)
    }
    /** The model service a text rebuild's first message goes to, in the web's words. */
    func seedService(_ summary: NativeJSON) -> String {
        if let id = summary["providerId"].string, let name = snapshot["catalog"]["providers"].array.first(where: { $0["id"].string == id })?["name"].string { return name }
        return engineName(summary["harnessId"].string) + " 用的模型服务"
    }
}
