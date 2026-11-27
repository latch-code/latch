import Foundation
import LatchNativeCore

struct PhoneDecisionContext {
    let sessionId: String
    let runId: String?
    let isCurrent: @MainActor () -> Bool
}

extension PhoneModel {
    var canQueueAttachments: Bool { canQueueCurrent && snapshot["catalog"]["features"]["queueAttachments"].bool }
    var canQueueCurrent: Bool { snapshot["catalog"]["features"]["queue"].bool }
    var currentSummary: NativeJSON { PhoneSessions.currentSummary(snapshot: snapshot, detail: detail, sessionId: sessionId, cached: detailCached) }
    /** Whether the open session is stopping: this phone asked and has no answer yet, or the Host says so, whoever asked. */
    var stoppingCurrent: Bool {
        guard let sessionId else { return false }
        return controlsInFlight.contains(Self.cancelPath(sessionId)) || PhoneSessions.rowStatus(currentSummary) == .stopping
    }
    static func cancelPath(_ id: String) -> String { "/link/api/tasks/\(id)/cancel" }
    static func approvalPath(_ id: String) -> String { "/link/api/approvals/" + id }
    private func performControl(path: String, fields: [String: NativeJSON], context: PhoneDecisionContext? = nil) async {
        guard context?.isCurrent() != false else { return }
        #if LATCH_SCREENS
        if staged, ScreensStage.finishConsultationApproval(path, fields: fields, model: self) { return }
        #endif
        guard let workspace, transportReady, !path.hasSuffix("/cancel") || !controlsInFlight.contains(path) else { return }
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
                guard generation == current, transportReady, context?.isCurrent() != false else { return }
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
    func findMentionFiles(_ query: String, in scope: PhoneMentionScope) async throws -> PhoneFileMatches {
        let host = generation, selection = contentGeneration, window = privateSnapshot.epoch
        func current() -> Bool {
            guard host == generation, selection == contentGeneration, window == privateSnapshot.epoch,
                  connected, hasContentWindow, scope.offered(in: snapshot) else { return false }
            if case let .session(id) = scope { return id == sessionId }
            return true
        }
        guard current() else { throw NativeFailure.contextChanged }
        #if LATCH_SCREENS
        if staged { return try ScreensStage.fileMatches(query) }
        #endif
        guard let workspace, let access = currentFileAccess else { throw NativeFailure.expired }
        let matches = try await workspace.findMentionFiles(query, in: scope, access: access)
        try Task.checkCancellation()
        guard current(), currentFileAccess?.transport === access.transport, currentFileAccess?.lease.sameWindow(as: access.lease) == true else {
            throw NativeFailure.contextChanged
        }
        return matches
    }
    func attachStartFiles(_ files: [PhoneFileMatches.Hit], to fields: inout [String: NativeJSON]) throws {
        guard !files.isEmpty else { return }
        guard fields["mode"]?.string == "agent", let project = fields["workspaceId"]?.string, let harness = fields["harnessId"]?.string else {
            throw NativeFailure.forbidden
        }
        try PhoneMentionScope.project(workspace: project, harness: harness).attach(files, to: &fields, snapshot: snapshot)
    }
    func start(_ choice: PhoneStartChoice, prompt: String, attachments: [String] = [], fileRefs: [PhoneFileMatches.Hit] = []) async -> Bool {
        guard transportReady else { return false }
        let current = generation
        do {
            guard canRun, PhoneConversation.promptLengthIssue(prompt) == nil, attachments.count <= PhoneAttachments.perMessage else { throw NativeFailure.forbidden }
            sessionId = nil; detail = .null; contentGeneration = UUID()
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            var fields = PhoneStart.newSessionFields(snapshot["catalog"], choice: choice, prompt: prompt)
            try attachStartFiles(fileRefs, to: &fields)
            if !attachments.isEmpty { fields["attachmentIds"] = .array(attachments.map { .string($0) }) }
            let done = await submit(try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fields))
            if done, sessionId != nil { startEvents() }
            return done
        } catch { report(error); return false }
    }
    /** `steer`: into the running turn, where the Harness takes that now. A message after 清空上下文 starts a new context; it is never queued or steered. */
    /** `target`: with attachments, the session the send began in; the message goes nowhere else. */
    @discardableResult func send(text: String, queue: Bool = false, steer: Bool = false, nextModel: PhoneModelChoice? = nil, attachments: [String] = [], fileRefs: [PhoneFileMatches.Hit] = [], target: String?? = nil, takingDraft: Bool = false) async -> Bool {
        guard transportReady else { return false }
        if let target, target != sessionId { if let key = target { attachTrays[key, default: PhoneAttachTray()].note = PhoneAttachSend.movedWords }; return false }
        guard !phonePromptTrim(text).isEmpty || !attachments.isEmpty, PhoneConversation.promptLengthIssue(text) == nil,
              attachments.count <= PhoneAttachments.perMessage,
              attachments.isEmpty || ((!steer || detail["steerAttachments"].bool) && (!queue || canQueueAttachments)) else { return false }
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
            if !fileRefs.isEmpty {
                guard let selected else { throw NativeFailure.forbidden }
                try PhoneMentionScope.session(selected).attach(fileRefs, to: &fields, snapshot: snapshot)
            }
            if !attachments.isEmpty { fields["attachmentIds"] = .array(attachments.map { .string($0) }) }
            let sent = await submit(try NativePendingWrite(method: .post, path: path, fields: fields), takingDraft: takingDraft)
            if sent, fresh, pending.isEmpty, let selected { clearing.remove(selected) }
            return sent
        } catch { report(error); return false }
    }
    func sendTeamRound(_ round: PhoneMemberMentions.Round, draft: String, session: String, hasMaterials: Bool) async -> Bool {
        guard round.reason == nil, sessionId == session, detail["summary"]["id"].string == session, pending.isEmpty,
              PhoneMemberMentions(snapshot: snapshot, session: session)?.round(in: draft, hasMaterials: hasMaterials) == round else { return false }
        do {
            let receipt = try PhoneTeamRoundReceipt(session: session, team: round.teamId, opening: heldDrafts.opening, draft: draft)
            let request = try receipt.write(itemIds: round.itemIds, prompt: round.prompt)
            let reading = contentGeneration
            guard canRun, hasContentWindow, privateSnapshot.confirmed, let transport = installedTransport else { return false }
            let outcome = await write(request, on: transport) {
                self.sessionId == session && self.contentGeneration == reading
                    && PhoneMemberMentions(snapshot: self.snapshot, session: session)?.round(in: draft, hasMaterials: hasMaterials) == round
            }
            switch outcome {
            case .done: receipt.clearSentDraft(in: heldDrafts); return true
            case let .refused(refusal): error = refusal.message.isEmpty ? "未能派给团队成员" : refusal.message
            case let .unknown(refusal): if let refusal, !refusal.message.isEmpty { error = "结果未确认 · " + refusal.message }
            case let .failed(problem): if !(problem is CancellationError) { report(problem) }
            }
            return false
        } catch { report(error); return false }
    }
    @discardableResult func submit(_ request: NativePendingWrite, takingDraft: Bool = false, whileCurrent: () -> Bool = { true }) async -> Bool {
        if request.teamRound != nil { return false }
        guard let workspace, transportReady, !busy else { return false }
        let current = generation, initialReading = contentGeneration
        do { try await ensureVerified(whileCurrent: whileCurrent) } catch { report(error); return false }
        guard current == generation, initialReading == contentGeneration, transportReady, !busy, whileCurrent() else { return false }
        // Older pending writes belong to this Host and may already have succeeded. Only their original request may settle them.
        if !pending.contains(where: { $0.requestId == request.requestId }) {
            let owner = PhonePending.topicOwner(request) ?? PhoneHistory.promptSession(request.path).flatMap { PhoneAgentChat.owner(summary(of: $0)) }
            if let reason = agentDestination(owner).localBlocker { error = reason; return false }
        }
        let selected = sessionId, reading = contentGeneration
        busy = true; defer { if generation == current { busy = false } }
        // A message with attachments hears the Host's own refusal: `attachment-released` proves it was not delivered, even on a retry.
        let attached = PhoneAttachments.count(request) > 0, retried = pending.contains { $0.requestId == request.requestId }
        let promptSession = PhoneHistory.promptSession(request.path)
        let opening = heldDrafts.opening, window = privateSnapshot.epoch
        var taken: String?
        if let id = promptSession {
            submittingPromptId = request.requestId
            if takingDraft, !retried, let text = PhonePending.prompt(request) {
                taken = heldDrafts.take(for: id, matching: text)
            }
        }
        defer { if generation == current, submittingPromptId == request.requestId { submittingPromptId = nil } }
        var mayReturnPrompt: Bool {
            guard let promptSession, hasContentWindow, privateSnapshot.accepts(window), canRun else { return false }
            return PhoneSessions.mayReadBody(snapshot: snapshot, sessionId: promptSession)
        }
        func discardRefusedWrite(confirmedRetry: Bool = false, mayRestore: Bool = true) {
            pending.removeAll { $0.requestId == request.requestId }
            heldDrafts.restoreRefusedPrompt(request, taken: taken, confirmedRetry: confirmedRetry, opening: opening, permitted: mayRestore && mayReturnPrompt)
        }
        do {
            if !retried { pending.append(request) }
            let value = try await workspace.submit(request, explain: attached || PhoneQueueControl(request) != nil,
                retryAnswered: { attached && $0.code == "attachment-released" })
            guard generation == current else { return false }
            // Keep the submitting row until the refreshed transcript can take its place.
            if promptSession == nil { pending.removeAll { $0.requestId == request.requestId } }
            defer { if promptSession != nil, generation == current { pending.removeAll { $0.requestId == request.requestId } } }
            if attached, let key = Self.trayKey(request) { attachmentsSent(key) }
            guard contentGeneration == reading else { return false }
            if let target = selected, sessionId == target, hasContentWindow, canRun,
               request.path == "/link/api/tasks/\(target)/conversation-references", let ref = value["reference"].string, UUID(uuidString: ref) != nil {
                let fields = try? JSONDecoder().decode(NativeJSON.self, from: request.body)
                let name = fields?["source"].string.flatMap { self.summary(of: $0)["title"].string } ?? "会话"
                addToDraft("[conversation-ref:\(ref)] " + name.components(separatedBy: .newlines).joined(separator: " ") + " · read_conversation_reference", session: target)
            }
            if sessionId == selected, contentGeneration == reading, let id = value["sessionId"].string { sessionId = id }
            if request.method == "DELETE", value["removed"].bool, value["deliveryUnknown"].bool {
                error = "排队项已移除。先前的发送结果仍待确认，请核对会话记录。"
            }
            await refresh()
            return true
        } catch let unsettled as NativeUnsettledRefusal {
            // Still unknown: the pending row stays, with the Host's words.
            guard generation == current, contentGeneration == reading else { return false }
            error = unsettled.refusal.message.isEmpty ? NativeFailure.resultUnknown.errorDescription : unsettled.refusal.message
            return false
        } catch let refusal as NativeHostRefusal {
            guard generation == current else { return false }
            discardRefusedWrite(confirmedRetry: retried)
            // A released attachment still belongs to the original session's tray after navigating away.
            guard hasContentWindow, privateSnapshot.accepts(window),
                  contentGeneration == reading || (refusal.code == "attachment-released" && mayReturnPrompt) else { return false }
            attachmentRefused(request, refusal: refusal, retried: retried)
            return false
        } catch {
            guard generation == current else { return false }
            let failure = error as? NativeFailure
            // A local retry failure says nothing about delivery of the first request.
            if failure != .resultUnknown && !(retried && promptSession != nil) {
                discardRefusedWrite(mayRestore: failure != .expired && failure != .revoked && failure != .forbidden && failure != .contextChanged)
            }
            guard contentGeneration == reading else { return false }
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
            // Sessions use heldDrafts; the new-session sheet and a new topic have their own fields.
            if retried, key.hasPrefix("\u{0}"), let text = PhonePending.prompt(request), !text.isEmpty { returnedText[key] = text }
            return
        }
        error = refusal.message.isEmpty ? "暂时无法完成，请稍后重试。" : refusal.message
    }
    /** A person releases this phone's pending queue change or team round. The Host keeps its delivery record. */
    func abandonSessionWrite(_ request: NativePendingWrite) async {
        guard let workspace, !busy, hasContentWindow, request.teamRound != nil || PhoneQueueControl(request) != nil,
              pending.contains(where: { $0.requestId == request.requestId }) else { return }
        let current = generation
        busy = true; defer { if generation == current { busy = false } }
        do {
            try await workspace.settlePending(request.requestId)
            guard generation == current else { return }
            pending.removeAll { $0.requestId == request.requestId }
            await refresh()
        } catch { if current == generation { report(error) } }
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
    @discardableResult func mutate(_ method: NativeHTTPMethod, path: String, fields: [String: NativeJSON], context: PhoneDecisionContext? = nil) async -> Bool {
        let whileCurrent: @MainActor () -> Bool = { context?.isCurrent() != false }
        guard whileCurrent() else { return false }
        #if LATCH_SCREENS
        if staged, method == .post, ScreensStage.finishConsultationApproval(path, fields: fields, model: self) { return true }
        if staged, ScreensStage.scene == "question-reminder", method == .post,
           path == "/link/api/tasks/ses_review/questions/question-work/answer" {
            return ScreensStage.answerFixtureQuestion(fields, model: self)
        }
        #endif
        let current = generation, reading = contentGeneration
        do {
            // Turning a request down reduces what runs, so the Host asks only that the device can see it.
            let declining = fields["decision"] == .string("reject") && connected && snapshot["device"]["status"].string == "active"
            guard declining || (path.hasPrefix("/link/api/approvals/") ? canApproveStandard || canApproveElevated || canRun : canRun) else { throw NativeFailure.forbidden }
            try await ensureVerified(whileCurrent: whileCurrent)
            guard current == generation, contentGeneration == reading, whileCurrent() else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            return await submit(try NativePendingWrite(method: method, path: path, fields: fields), whileCurrent: whileCurrent)
        }
        catch { report(error); return false }
    }
    /** Captures the run the stop button was drawn for, including a newer body than the session list. */
    var currentStopContext: PhoneDecisionContext? {
        guard let id = sessionId, Self.canStop(currentSummary) else { return nil }
        let host = generation, run = Self.stopRun(currentSummary)
        return PhoneDecisionContext(sessionId: id, runId: run) { [weak self] in
            guard let self, generation == host, sessionId == id else { return false }
            let summary = currentSummary
            return Self.canStop(summary) && Self.stopRun(summary) == run
        }
    }
    private static func stopRun(_ summary: NativeJSON) -> String? {
        summary["runId"].string ?? summary["live"]["runId"].string
    }
    private static func canStop(_ summary: NativeJSON) -> Bool {
        ["running", "waiting-approval"].contains(summary["status"].string ?? "") && summary["live"]["activity"].string != "cancelling"
    }
    func stop(context: PhoneDecisionContext) async {
        guard context.isCurrent() else { return }
        let id = context.sessionId
        var fields: [String: NativeJSON] = ["requestId": .string(UUID().uuidString)]
        let summary = id == sessionId ? currentSummary : (snapshot["tasks"].array.first { $0["id"].string == id } ?? .null)
        if let run = context.runId ?? Self.stopRun(summary) { fields["runId"] = .string(run) }
        await performControl(path: Self.cancelPath(id), fields: fields, context: context)
    }
    func reject(_ id: String, context: PhoneDecisionContext? = nil) async {
        await performControl(path: Self.approvalPath(id), fields: ["decision": .string("reject"), "requestId": .string(UUID().uuidString)], context: context)
    }
    func allow(_ id: String, option: String?, context: PhoneDecisionContext? = nil) async {
        var fields: [String: NativeJSON] = ["decision": .string("allow")]
        if let option { fields["optionId"] = .string(option) }
        await mutate(.post, path: Self.approvalPath(id), fields: fields, context: context)
    }
    /** One of 更多's choices: the option the Host named, kept with its requestId until it is answered. */
    func decide(_ id: String, option: String, allows: Bool, context: PhoneDecisionContext? = nil) async {
        await mutate(.post, path: Self.approvalPath(id), fields: ["decision": .string(allows ? "allow" : "reject"), "optionId": .string(option)], context: context)
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
