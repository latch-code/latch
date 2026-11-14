import Foundation
import LatchNativeCore

/** The review page: its session, the scope its diff shows, and whether 提交 is pushed over it. */
struct PhoneReviewTarget: Identifiable, Hashable {
    let sessionId: String
    var scope: PhoneReviewScope = .turn
    /** A file to land on, from 提交's list. */
    var file: String?
    var id: String { sessionId }
}

/** 交给代码任务… from one turn: the messages it can carry. */
struct PhoneHandoffDraft: Identifiable {
    let sourceSessionId: String
    let materials: [PhoneHandoffMessage]
    let id = UUID()
}

/** How a write the page waits on ended. */
enum PhoneWriteOutcome {
    case done(NativeJSON)
    /** The Host said no, in its own words. */
    case refused(NativeHostRefusal)
    /** No answer: kept with its request ID until the same request is sent again. A retry the Host refused without settling
     * it carries that refusal, shown under the row. */
    case unknown(NativeHostRefusal?)
    case failed(Error)
}

extension PhoneModel {
    func resetReview() {
        reviewTarget = nil; reviewShortcuts = [:]; turnRecords = [:]; turnReads = []; seenState = nil; hostNotice = nil; lostSessions = []; historyCloser = PhoneHistoryCloser()
        sessionHandoffs = nil; handoffSignature = ""; handoffDraft = nil; editPaths = [:]
    }

    /**
     * A write of the review, the commit page, the editor or a handoff: the same window, receipts and one-at-a-time rule as
     * a message, with the Host's refusal handed back instead of said in an alert, and the Host read again either way.
     */
    func write(_ request: NativePendingWrite, timeout: Int64 = 15, retryAnswered: (@Sendable (NativeHostRefusal) -> Bool)? = nil, refresh again: Bool = true) async -> PhoneWriteOutcome {
        guard let workspace else { return .failed(NativeFailure.unavailable) }
        let current = generation
        // Busy from the first moment, so 放弃这次结果 cannot drop a write this is about to send.
        guard !busy else { return .failed(NativeFailure.resultUnknown) }
        busy = true; defer { if generation == current { busy = false } }
        do {
            guard canRun else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation else { return .failed(NativeFailure.unavailable) }
            // An earlier write without an answer goes first: the core keeps one unconfirmed write at a time.
            guard pending.allSatisfy({ $0.requestId == request.requestId }) else { return .failed(NativeFailure.resultUnknown) }
        } catch { return .failed(error) }
        if !pending.contains(where: { $0.requestId == request.requestId }) { pending.append(request) }
        do {
            let value = try await workspace.submit(request, timeoutSeconds: timeout, explain: true, retryAnswered: retryAnswered)
            guard generation == current else { return .failed(NativeFailure.unavailable) }
            pending.removeAll { $0.requestId == request.requestId }
            if again { busy = false; await refresh() }
            return .done(value)
        } catch let unsettled as NativeUnsettledRefusal {
            return .unknown(unsettled.refusal)
        } catch let refusal as NativeHostRefusal {
            guard generation == current else { return .failed(NativeFailure.unavailable) }
            pending.removeAll { $0.requestId == request.requestId }
            if again { busy = false; await refresh() }
            return .refused(refusal)
        } catch {
            guard generation == current else { return .failed(error) }
            if (error as? NativeFailure) == .resultUnknown { return .unknown(nil) }
            pending.removeAll { $0.requestId == request.requestId }
            if (error as? NativeFailure) == .expired { report(error) }
            return .failed(error)
        }
    }
    /** 重试这次提交: the same request; a Git, file or handoff write waits as long as the Host gives it and reads its receipt. */
    func retryPending(_ request: NativePendingWrite) async {
        if PhoneHistory.isImport(request) {
            let (outcome, retry) = await importHistory(request)
            switch outcome {
            case let .done(value): if let taskId = PhoneHistory.importedTask(value) { flushHistoryCloses(); await openImported(taskId) }
            case let .refused(refusal):
                releaseImportPreview(request)
                switch PhoneHistory.outcome(refusal, retry: retry) {
                case let .open(taskId): await openImported(taskId)
                case .notDone: error = PhoneHistory.notDoneWords
                case .deletedSince: error = PhoneHistory.deletedSinceWords
                default: error = refusal.message.isEmpty ? "没有接入" : refusal.message
                }
            case let .failed(failure): releaseImportPreview(request); report(failure)
            case let .unknown(refusal): if let refusal, !refusal.message.isEmpty { error = "结果未确认 · " + refusal.message }
            }
            return
        }
        if PhoneAgentWrites.handles(request) || PhoneHelperCreate.isCreation(request) {
            switch await writeAgent(request) {
            case let .refused(words): error = words
            case .changed: error = "已在别处修改"
            case .done, .unknown: break
            }
            return
        }
        let special = PhoneDelivery.pendingWords(request) ?? PhoneFileEdit.pendingWords(request) ?? PhoneHandoffs.pendingWords(request) ?? PhoneReview.pendingWords(request)
        guard special != nil else { await submit(request); return }
        switch await write(request, timeout: PhoneDelivery.timeout(request), retryAnswered: PhoneDelivery.retryAnswered(request)) {
        case let .refused(refusal): error = refusal.message.isEmpty ? "没有完成" : refusal.message
        case let .failed(failure): report(failure)
        case .done, .unknown: break
        }
    }
    /** A pending write the Host now holds and answers itself; this device's copy is dropped, never sent again. */
    func settle(_ request: NativePendingWrite) async {
        guard !busy else { return }
        _ = await drop(request)
    }
    /** This device's copy gone, or false when the core kept it (a write of it is under way). */
    private func drop(_ request: NativePendingWrite) async -> Bool {
        guard let workspace else { return false }
        do { try await workspace.settlePending(request.requestId) } catch { return false }
        pending.removeAll { $0.requestId == request.requestId }
        editPaths.removeValue(forKey: request.requestId)
        return true
    }
    /**
     * The words for what is there now, once the write is dropped; nil when it was not (busy, the Mac away, a check that
     * could not finish), so the write and its retry stay. Busy for the whole check, so no retry starts meanwhile.
     */
    func checkAndDrop(_ request: NativePendingWrite) async -> String? {
        guard pending.contains(where: { $0.requestId == request.requestId }), !busy else { return nil }
        let current = generation
        busy = true; defer { if generation == current { busy = false } }
        if PhoneDelivery.isStage(request) { return await drop(request) ? "已按电脑上现在的暂存状态显示" : nil }
        guard let save = PhoneFileEdit.pendingSave(request), let workspace, let sessionId = request.path.split(separator: "/").dropFirst(3).first.map(String.init),
              let path = editPaths[request.requestId] else {
            // The editor that sent it is gone with its file's name: nothing left to compare it with.
            return await drop(request) ? PhoneFileEdit.uncheckable : nil
        }
        do {
            try await ensureVerified()
            let resolved: NativeJSON
            do { resolved = try await workspace.resolveFile(sessionId: sessionId, reference: path.reference, rootId: path.root) }
            catch NativeFailure.unsupported, NativeFailure.forbidden { resolved = .null }
            let meta = resolved["files"].array.first?["file"] ?? .null
            // Deleted, renamed, refused or past 1 MiB: nothing can be compared, and the write must not block every other.
            guard resolved["files"].array.first?["status"].string == "ok", let handle = meta["handle"].string, let etag = meta["etag"].string,
                  let size = meta["size"].integer, size <= UInt64(PhoneFileEdit.limit) else {
                return await drop(request) ? PhoneFileEdit.uncheckable : nil
            }
            let bytes = size == 0 ? Data() : try await workspace.fileBytes(handle: handle, etag: etag, offset: 0, count: Int(size))
            guard generation == current, await drop(request) else { return nil }
            return PhoneFileEdit.checkWords(saved: PhoneFileEdit.settled(content: save.content, current: bytes))
        } catch { return nil }
    }
    /** A read of the review's routes inside the window; errors are the caller's to show. */
    func reviewRead(_ path: String) async throws -> NativeJSON {
        #if LATCH_SCREENS
        if staged { return try ScreensStage.review(path) }
        #endif
        guard let workspace else { throw NativeFailure.unavailable }
        try await ensureVerified()
        return try await workspace.read(path, body: true)
    }

    // MARK: seen, and the list's shortcut

    func loadSeen() async {
        guard seenState == nil, let workspace else { return }
        let current = generation
        if let value = try? await workspace.seen(), current == generation {
            seenState = value
            if let pruned = value.pruned(snapshot["tasks"].array), !snapshot["tasks"].array.isEmpty { seenState = pruned; try? await workspace.storeSeen(pruned) }
            refreshReviewShortcuts()
        }
    }
    func markSeen(_ id: String) {
        guard let workspace, let updated = summary(of: id)["updatedAt"].string, let next = seenState?.marking(id, updatedAt: updated) else { return }
        seenState = next
        Task { try? await workspace.storeSeen(next) }
        refreshReviewShortcuts()
    }
    func unread(_ task: NativeJSON) -> Bool { seenState?.unread(task) ?? false }
    /**
     * 「复核 N 处改动」 for the list's rows: each candidate's turn records are read once per `updatedAt`, only where this
     * device may read them; the others go by the snapshot's note counts. Until its records come a row offers nothing.
     */
    func refreshReviewShortcuts() {
        guard seenState != nil else { Task { await loadSeen() }; return }
        let candidates = PhoneReview.candidates(snapshot) { unread($0) }
        let reads = PhoneReview.readsTurns(snapshot) && verifiedUntil != nil
        var next: [String: String] = [:]
        for task in candidates {
            guard let id = task["id"].string else { continue }
            let key = id + "\n" + (task["updatedAt"].string ?? "")
            if reads, turnRecords[key] == nil { readTurns(id, key: key); continue }
            if let label = PhoneReview.shortcut(task, unread: unread(task), turns: reads ? turnRecords[key] ?? nil : nil, counts: PhoneReview.counts(snapshot, id)) {
                next[id] = label
            }
        }
        if next != reviewShortcuts { reviewShortcuts = next }
    }
    private func readTurns(_ id: String, key: String, attempt: Int = 0) {
        guard attempt > 0 || turnReads.insert(key).inserted, let workspace else { return }
        let current = generation
        Task {
            do {
                let value = try await workspace.read(try PhoneReview.turnsPath(id), body: true)
                guard current == generation else { return }
                let turns = Array(value["turns"].array.prefix(64))
                // A run just settled may not be recorded yet: ask again shortly, a bounded number of times.
                if turns.last?["state"].string == "running" && attempt < 20 {
                    try await Task.sleep(for: .milliseconds(1500))
                    guard current == generation else { return }
                    readTurns(id, key: key, attempt: attempt + 1); return
                }
                turnRecords[key] = .some(turns)
            } catch {
                guard current == generation else { return }
                turnRecords[key] = .some(nil)
            }
            refreshReviewShortcuts()
        }
    }
    func openReview(_ id: String) {
        reviewTarget = PhoneReviewTarget(sessionId: id)
        markSeen(id)
    }

    // MARK: handoffs

    /** The open session's handoffs, read when the snapshot's summaries for it change. */
    func loadHandoffs(_ id: String) async {
        let signature = PhoneHandoffs.involved(snapshot, sessionId: id)
        guard snapshot["catalog"]["features"]["handoffs"].bool || !signature.isEmpty, verifiedUntil != nil else { return }
        if signature.isEmpty { sessionHandoffs = (id, []); handoffSignature = id; return }
        guard handoffSignature != id + signature || sessionHandoffs?.sessionId != id, let workspace else { return }
        let current = generation, reading = contentGeneration
        do {
            let value = try await workspace.read(try PhoneHandoffs.listPath(id), body: true)
            guard current == generation, reading == contentGeneration, sessionId == id else { return }
            sessionHandoffs = (id, Array(value["handoffs"].array.prefix(256))); handoffSignature = id + signature
        } catch {}
    }
    var openHandoffs: [NativeJSON] { sessionHandoffs?.sessionId == sessionId ? sessionHandoffs?.list ?? [] : [] }

    /** Text into a session's composer draft, never sent: the hook output, or a returned result as a quote. */
    func addToDraft(_ text: String, session id: String) {
        draftInserts[id] = (draftInserts[id].map { $0 + "\n\n" } ?? "") + text
    }
    /** What was put into this session's draft from elsewhere, once, inside a window. */
    func takeInsert(for id: String?) -> String? {
        guard verifiedUntil != nil, let id else { return nil }
        return draftInserts.removeValue(forKey: id)
    }
}
