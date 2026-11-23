import Foundation
import LatchNativeCore

extension PhoneModel {
    var canQueueCurrent: Bool { snapshot["catalog"]["features"]["queue"].bool }
    var currentSummary: NativeJSON { PhoneSessions.currentSummary(snapshot: snapshot, detail: detail, sessionId: sessionId, cached: detailCached) }
    /** Whether the open session is stopping: this phone asked and has no answer yet, or the Host says so, whoever asked. */
    var stoppingCurrent: Bool {
        guard let sessionId else { return false }
        return controlsInFlight.contains(Self.cancelPath(sessionId)) || PhoneSessions.rowStatus(currentSummary) == .stopping
    }
    private static func cancelPath(_ id: String) -> String { "/link/api/tasks/\(id)/cancel" }
    static func approvalPath(_ id: String) -> String { "/link/api/approvals/" + id }
    private func performControl(path: String, fields: [String: NativeJSON], work: PhoneWorkDecisionContext? = nil) async {
        guard let workspace, transportReady, permitsWorkDecision(work) else { return }
        let current = generation, previous = controlTail
        controlsInFlight.insert(path)
        let turn = Task { @MainActor in
            await previous?.value
            guard generation == current, transportReady else { return }
            do {
                var body = fields
                if let saved = try await workspace.pendingControl() {
                    var earlier = saved["fields"].object, requested = fields
                    earlier.removeValue(forKey: "requestId"); requested.removeValue(forKey: "requestId")
                    guard saved["path"].string == path, earlier == requested else {
                        // This one was never sent: the earlier control must be confirmed first.
                        await refreshControlPending(); report(NativeFailure.resultUnknown); return
                    }
                    body = saved["fields"].object
                }
                guard generation == current, transportReady, permitsWorkDecision(work) else { return }
                _ = try await workspace.freeAction(path: path, fields: body)
                guard generation == current else { return }
                await refreshControlPending(); _ = await refresh()
            } catch {
                guard generation == current else { return }
                await refreshControlPending()
                // The pending bar already says it and offers the same request again.
                if (error as? NativeFailure) != .resultUnknown { report(error) }
            }
        }
        controlTail = turn
        await turn.value
        if generation == current { controlsInFlight.remove(path) }
    }
    /**
     * Content opens without asking. With Face ID turned on in 设置, its sheet appears by itself the first time content is
     * opened; declining it is not an error: the conversation offers the one way back, and nothing else nags.
     */
    func openSession(_ id: String, resuming retained: BodyLease? = nil, fromInbox: Bool = false) async {
        guard let workspace else { sessionId = id; detail = .null; return }
        let current = generation
        let reading = UUID(), selectedTab = tab, selectedPath = agentPath
        sessionId = id; detail = .null; detailFailed = nil; contentGeneration = reading; PreviewFiles.clear()
        func stillReading() -> Bool {
            current == generation && sessionId == id && contentGeneration == reading
                && ((!fromInbox && retained == nil) || (selectedTab == tab && selectedPath == agentPath))
                && retained?.valid != false && (!fromInbox || (!workItemsShown && PhoneSessions.mayReadBody(snapshot: snapshot, sessionId: id)))
        }
        do {
            // If the shelf is already opening this window, wait for its binding before capturing the content epoch.
            if let opening = teamListOpening, opening.transport === installedTransport { try await opening.task.value }
            guard stillReading(), !Task.isCancelled else { return }
            try await ensureVerified(resuming: retained, whileCurrent: stillReading)
        }
        catch {
            guard stillReading(), !(error is CancellationError) else { return }
            if (error as? NativeFailure) != .declined, !wentAway(error) { report(error) }
            return
        }
        let transport = installedTransport
        guard let lease = await workspace.lease(), stillReading(), retained?.sameWindow(as: lease) != false else { return }
        do {
            let applied = try await readSelectedBody(id, workspace: workspace)
            guard stillReading() else { return }
            try lease.requireValid()
            if applied { startEvents() }
        } catch {
            guard stillReading() else { return }
            if wentAway(error) {
                // The window is still open, and this is what it last read; it is said to be old where it is shown.
                if let cached = try? await workspace.cachedDetail(id), stillReading(), lease.valid,
                   installedTransport === transport, transport?.valid == true, detail == .null { detail = cached; detailCached = true }
            } else if [NativeFailure.expired, .forbidden, .contextChanged].contains(error as? NativeFailure) { report(error) }
            else { detailFailed = id }
        }
    }
    /** Keeps unsent text out of sight with the window it was written beside. */
    func holdDraft(_ text: String, for id: String?) {
        guard store != nil, let id else { return }
        heldDrafts.set(text, for: id, opening: heldDrafts.opening, permitted: true)
    }
    func takeDraft(for id: String?) -> String? {
        guard verifiedUntil != nil, let id else { return nil }
        return heldDrafts.take(for: id)
    }
    /** Back to the list; the window stays open for the next conversation. */
    func closeSession() { sessionId = nil; detail = .null; contentGeneration = UUID(); PreviewFiles.clear(); startEvents() }
    func start(_ choice: PhoneStartChoice, prompt: String, attachments: [String] = []) async -> Bool {
        guard transportReady else { return false }
        let current = generation
        do {
            guard canRun, prompt.count <= 16_000, attachments.count <= PhoneAttachments.perMessage else { throw NativeFailure.forbidden }
            sessionId = nil; detail = .null; contentGeneration = UUID()
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            var fields = PhoneStart.newSessionFields(snapshot["catalog"], choice: choice, prompt: prompt)
            if !attachments.isEmpty { fields["attachmentIds"] = .array(attachments.map { .string($0) }) }
            let done = await submit(try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fields))
            if done, sessionId != nil { startEvents() }
            return done
        } catch { report(error); return false }
    }
    /** `steer`: into the running turn, where the Harness takes that now. A message after 清空上下文 starts a new context; it is never queued or steered. */
    /** `target`: with attachments, the session the send began in; the message goes nowhere else. */
    @discardableResult func send(text: String, queue: Bool = false, steer: Bool = false, nextModel: PhoneModelChoice? = nil, attachments: [String] = [], target: String?? = nil) async -> Bool {
        guard transportReady else { return false }
        if let target, target != sessionId { if let key = target { attachTrays[key, default: PhoneAttachTray()].note = PhoneAttachSend.movedWords }; return false }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty, text.count <= 16_000,
              attachments.count <= PhoneAttachments.perMessage, attachments.isEmpty || (!queue && !steer) else { return false }
        let current = generation, selected = sessionId, reading = contentGeneration
        do {
            guard canRun else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation, selected == sessionId, reading == contentGeneration else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            let path = selected.map { "/link/api/tasks/" + $0 + "/prompt" } ?? "/link/api/tasks"
            var fields: [String: NativeJSON] = ["prompt": .string(text)]
            if let nextModel, sessionId != nil { fields["model"] = .object(["providerId": .string(nextModel.providerId), "model": .string(nextModel.model)]) }
            if steer { fields["steer"] = .bool(true) }
            else if queue { fields["queue"] = .bool(true) }
            else if sessionId == nil { fields["mode"] = .string("agent") }
            let fresh = sessionId.map { clearing.contains($0) && !queue && !steer } ?? false
            if fresh { fields["freshContext"] = .bool(true) }
            if !attachments.isEmpty { fields["attachmentIds"] = .array(attachments.map { .string($0) }) }
            let sent = await submit(try NativePendingWrite(method: .post, path: path, fields: fields))
            if sent, fresh, pending.isEmpty, let selected { clearing.remove(selected) }
            return sent
        } catch { report(error); return false }
    }
    @discardableResult func submit(_ request: NativePendingWrite) async -> Bool {
        guard let workspace, transportReady, !busy else { return false }
        let current = generation, initialReading = contentGeneration
        do { try await ensureVerified() } catch { report(error); return false }
        guard current == generation, initialReading == contentGeneration, transportReady else { return false }
        let selected = sessionId, reading = contentGeneration
        busy = true; defer { if generation == current { busy = false } }
        // A message with attachments hears the Host's own refusal: `attachment-released` proves it was not delivered, even on a retry.
        let attached = PhoneAttachments.count(request) > 0, retried = pending.contains { $0.requestId == request.requestId }
        do {
            if !retried { pending.append(request) }
            let value = attached ? try await workspace.submit(request, explain: true, retryAnswered: { $0.code == "attachment-released" }) : try await workspace.submit(request)
            guard generation == current else { return false }
            pending.removeAll { $0.requestId == request.requestId }
            if attached, let key = Self.trayKey(request) { attachmentsSent(key) }
            guard contentGeneration == reading else { return false }
            if sessionId == selected, contentGeneration == reading, let id = value["sessionId"].string { sessionId = id }
            await refresh()
            return true
        } catch let unsettled as NativeUnsettledRefusal {
            // Still unknown: the pending row stays, with the Host's words.
            guard generation == current, contentGeneration == reading else { return false }
            error = unsettled.refusal.message.isEmpty ? NativeFailure.resultUnknown.errorDescription : unsettled.refusal.message
            return false
        } catch let refusal as NativeHostRefusal {
            guard generation == current, contentGeneration == reading else { return false }
            pending.removeAll { $0.requestId == request.requestId }
            attachmentRefused(request, refusal: refusal, retried: retried)
            return false
        } catch {
            guard generation == current, contentGeneration == reading else { return false }
            if (error as? NativeFailure) != .resultUnknown { pending.removeAll { $0.requestId == request.requestId } }
            // The Harness lost its own session: the stop row above the input says so and offers 按文字重建, as the web does.
            // Only a session brought in as it was gets that row; any other keeps the ordinary failure (HARNESSES.md).
            if (error as? NativeFailure) == .sessionLost, let id = PhoneHistory.promptSession(request.path),
               PhoneHistory.stopsAsLost(detail["summary"]["id"].string == id ? detail["summary"] : summary(of: id)) { lostSessions.insert(id); return false }
            report(error)
            return (error as? NativeFailure) == .resultUnknown
        }
    }
    /** The composer a message's attachments came from. */
    static func trayKey(_ request: NativePendingWrite) -> String? { PhoneAttachments.key(of: request) }
    /**
     * A message with attachments the Host refused for certain. Released uploads mark their rows (only 移除 is left) and a
     * retried message's text goes back into its input, as the web's does; anything else is said in the Host's words.
     */
    private func attachmentRefused(_ request: NativePendingWrite, refusal: NativeHostRefusal, retried: Bool) {
        let key = Self.trayKey(request)
        if refusal.code == "attachment-released", let key {
            attachTrays[key, default: PhoneAttachTray()].markReleased()
            attachTrays[key]?.note = PhoneAttachments.releasedWords
            // A session's composer takes it as an insert; the sheet and a new topic take it back into their own field.
            if retried, let text = PhonePending.prompt(request), !text.isEmpty {
                if key.hasPrefix("\u{0}") { returnedText[key] = text } else { draftInserts[key] = text }
            }
            return
        }
        error = refusal.message.isEmpty ? "暂时无法完成，请稍后重试。" : refusal.message
    }
    /**
     * 放弃这次提交: this phone stops waiting for a message's answer. When the open session already lists it by its
     * requestId it was delivered (`.delivered`); otherwise its text comes back (`.text`), to send again as a new message.
     * Nil while another write runs, so a retry in flight is never dropped.
     */
    func abandonPrompt(_ request: NativePendingWrite) async -> PhoneAbandoned? {
        guard let workspace, !busy, let text = PhonePending.prompt(request), pending.contains(where: { $0.requestId == request.requestId }) else { return nil }
        let current = generation
        busy = true; defer { if generation == current { busy = false } }
        // The session read afresh; the copy on screen only when that read fails.
        var seen = NativeJSON.null
        if case let .session(id) = PhonePending.kind(request) {
            if let fresh = try? await workspace.detail(id) { seen = fresh }
            else if detail["summary"]["id"].string == id { seen = detail }
            guard generation == current else { return nil }
        }
        let twin = PhonePending.queuedTwin(request, detail: seen)
        let delivered = PhonePending.delivered(request, detail: seen)
        do { try await workspace.settlePending(request.requestId) } catch { report(error); return nil }
        guard generation == current else { return nil }
        pending.removeAll { $0.requestId == request.requestId }
        // Its uploads stay held for that request on the Host (设置 › 设备 releases them); they cannot go with another.
        if PhoneAttachments.count(request) > 0, let key = Self.trayKey(request) {
            attachTrays[key]?.clear(); attachTrays[key] = nil
            if !delivered { attachTrays[key, default: PhoneAttachTray()].note = "附件随这次提交放下了，需要时重新添加" }
        }
        // Delivered, it took its 清空上下文 with it, as an answered send does.
        if delivered, case let .session(id) = PhonePending.kind(request) { clearing.remove(id) }
        return delivered ? .delivered : .text(text, queuedTwin: twin != nil)
    }
    @discardableResult func mutate(_ method: NativeHTTPMethod, path: String, fields: [String: NativeJSON], work: PhoneWorkDecisionContext? = nil) async -> Bool {
        #if LATCH_SCREENS
        if staged, ScreensStage.scene == "question-reminder", method == .post,
           path == "/link/api/tasks/ses_review/questions/question-work/answer" {
            return ScreensStage.answerFixtureQuestion(fields, model: self)
        }
        #endif
        guard permitsWorkDecision(work) else { return false }
        let current = generation, reading = contentGeneration
        do {
            // Turning a request down reduces what runs, so the Host asks only that the device can see it.
            let declining = fields["decision"] == .string("reject") && connected && snapshot["device"]["status"].string == "active"
            guard declining || (path.hasPrefix("/link/api/approvals/") ? canApproveStandard || canApproveElevated || canRun : canRun) else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation, contentGeneration == reading, permitsWorkDecision(work) else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            return await submit(try NativePendingWrite(method: method, path: path, fields: fields))
        }
        catch { report(error); return false }
    }
    func stop(work: PhoneWorkDecisionContext? = nil) async {
        guard workspace != nil, let id = sessionId, permitsWorkDecision(work) else { return }
        var fields: [String: NativeJSON] = ["requestId": .string(UUID().uuidString)]
        let summary = snapshot["tasks"].array.first { $0["id"].string == id } ?? detail["summary"]
        if let run = work?.source.runId ?? summary["runId"].string { fields["runId"] = .string(run) }
        await performControl(path: Self.cancelPath(id), fields: fields, work: work)
    }
    func reject(_ id: String, work: PhoneWorkDecisionContext? = nil) async {
        guard workspace != nil else { return }
        await performControl(path: Self.approvalPath(id), fields: ["decision": .string("reject"), "requestId": .string(UUID().uuidString)], work: work)
    }
    func allow(_ id: String, option: String?, work: PhoneWorkDecisionContext? = nil) async {
        var fields: [String: NativeJSON] = ["decision": .string("allow")]
        if let option { fields["optionId"] = .string(option) }
        await mutate(.post, path: "/link/api/approvals/" + id, fields: fields, work: work)
    }
    /** One of 更多's choices: the option the Host named, kept with its requestId until it is answered. */
    func decide(_ id: String, option: String, allows: Bool, work: PhoneWorkDecisionContext? = nil) async {
        await mutate(.post, path: "/link/api/approvals/" + id, fields: ["decision": .string(allows ? "allow" : "reject"), "optionId": .string(option)], work: work)
    }
    /** 继续等 only ever asks the Host for a longer threshold; it doubles what the request saw. */
    func keepWaiting() async {
        let live = currentSummary["live"]
        guard transportReady, let id = sessionId, let run = live["runId"].string, let threshold = live["silenceThresholdMs"].integer, let workspace else { return }
        do {
            _ = try await workspace.keepWaiting(sessionId: id, runId: run, thresholdMs: threshold)
            await refresh()
        } catch { if !wentAway(error) { report(error) } }
    }
}

/** What 放弃这次提交 left: the message was already in its session, or its text to put back into the input. */
enum PhoneAbandoned: Equatable {
    case delivered
    /** `queuedTwin`: the session's queue holds an item with the same text, perhaps another device's; it stays there. */
    case text(String, queuedTwin: Bool)
}

extension PhoneAbandoned {
    static let queuedTwinWords = "队列里同样文字的一条还在，在队列里发送或移除"
}
