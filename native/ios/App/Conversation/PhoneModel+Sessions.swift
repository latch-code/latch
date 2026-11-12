import Foundation
import LatchNativeCore

extension PhoneModel {
    var canQueueCurrent: Bool { snapshot["catalog"]["features"]["queue"].bool }
    var currentSummary: NativeJSON { snapshot["tasks"].array.first { $0["id"].string == sessionId } ?? detail["summary"] }
    /** Whether the open session is stopping: this phone asked and has no answer yet, or the Host says so, whoever asked. */
    var stoppingCurrent: Bool {
        guard let sessionId else { return false }
        return controlsInFlight.contains(Self.cancelPath(sessionId)) || PhoneSessions.rowStatus(currentSummary) == .stopping
    }
    private static func cancelPath(_ id: String) -> String { "/link/api/tasks/\(id)/cancel" }
    static func approvalPath(_ id: String) -> String { "/link/api/approvals/" + id }
    private func performControl(path: String, fields: [String: NativeJSON]) async {
        guard let workspace else { return }
        let current = generation, previous = controlTail
        controlsInFlight.insert(path)
        let turn = Task { @MainActor in
            await previous?.value
            guard generation == current else { return }
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
    func openSession(_ id: String) async {
        guard let workspace else { sessionId = id; detail = .null; return }
        let current = generation
        let reading = UUID()
        sessionId = id; detail = .null; detailFailed = nil; contentGeneration = reading; PreviewFiles.clear()
        func stillReading() -> Bool { current == generation && sessionId == id && contentGeneration == reading }
        do { try await ensureVerified() }
        catch {
            guard stillReading() else { return }
            if (error as? NativeFailure) != .declined, !wentAway(error) { report(error) }
            return
        }
        guard stillReading(), let lease = await workspace.lease() else { return }
        do {
            let value = try await workspace.detail(id)
            guard stillReading() else { return }
            try lease.requireValid()
            detail = value; startEvents()
        } catch {
            guard stillReading() else { return }
            if wentAway(error) {
                // The window is still open, and this is what it last read; it is said to be old where it is shown.
                if let cached = try? await workspace.cachedDetail(id), stillReading() { detail = cached; detailCached = true }
            } else if [NativeFailure.expired, .forbidden, .contextChanged].contains(error as? NativeFailure) { report(error) }
            else { detailFailed = id }
        }
    }
    /** Keeps unsent text out of sight with the window it was written beside. */
    func holdDraft(_ text: String, for id: String?) {
        guard store != nil, let id else { return }
        heldDrafts[id] = text.isEmpty ? nil : text
    }
    func takeDraft(for id: String?) -> String? {
        guard verifiedUntil != nil, let id else { return nil }
        return heldDrafts.removeValue(forKey: id)
    }
    /** Back to the list; the window stays open for the next conversation. */
    func closeSession() { sessionId = nil; detail = .null; contentGeneration = UUID(); PreviewFiles.clear(); startEvents() }
    func start(_ choice: PhoneStartChoice, prompt: String) async -> Bool {
        let current = generation
        do {
            guard canRun, prompt.count <= 16_000 else { throw NativeFailure.forbidden }
            sessionId = nil; detail = .null; contentGeneration = UUID()
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            let done = await submit(try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: PhoneStart.fields(snapshot["catalog"], choice: choice, prompt: prompt)))
            if done, sessionId != nil { startEvents() }
            return done
        } catch { report(error); return false }
    }
    /** `steer`: into the running turn, where the Harness takes that now. A message after 清空上下文 starts a new context; it is never queued or steered. */
    @discardableResult func send(text: String, queue: Bool = false, steer: Bool = false, nextModel: PhoneModelChoice? = nil) async -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 16_000 else { return false }
        let current = generation
        do {
            guard canRun else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            let path = sessionId.map { "/link/api/tasks/" + $0 + "/prompt" } ?? "/link/api/tasks"
            var fields: [String: NativeJSON] = ["prompt": .string(text)]
            if let nextModel, sessionId != nil { fields["model"] = .object(["providerId": .string(nextModel.providerId), "model": .string(nextModel.model)]) }
            if steer { fields["steer"] = .bool(true) }
            else if queue { fields["queue"] = .bool(true) }
            else if sessionId == nil { fields["mode"] = .string("agent") }
            let fresh = sessionId.map { clearing.contains($0) && !queue && !steer } ?? false
            if fresh { fields["freshContext"] = .bool(true) }
            let selected = sessionId
            let sent = await submit(try NativePendingWrite(method: .post, path: path, fields: fields))
            if sent, fresh, pending.isEmpty, let selected { clearing.remove(selected) }
            return sent
        } catch { report(error); return false }
    }
    @discardableResult func submit(_ request: NativePendingWrite) async -> Bool {
        guard let workspace, !busy else { return false }
        let current = generation, initialReading = contentGeneration
        do { try await ensureVerified() } catch { report(error); return false }
        guard current == generation, initialReading == contentGeneration else { return false }
        let selected = sessionId, reading = contentGeneration
        busy = true; defer { if generation == current { busy = false } }
        do {
            if !pending.contains(where: { $0.requestId == request.requestId }) { pending.append(request) }
            let value = try await workspace.submit(request)
            guard generation == current else { return false }
            pending.removeAll { $0.requestId == request.requestId }
            guard contentGeneration == reading else { return false }
            if sessionId == selected, contentGeneration == reading, let id = value["sessionId"].string { sessionId = id }
            await refresh()
            return true
        } catch {
            guard generation == current, contentGeneration == reading else { return false }
            if (error as? NativeFailure) != .resultUnknown { pending.removeAll { $0.requestId == request.requestId } }
            report(error)
            return (error as? NativeFailure) == .resultUnknown
        }
    }
    @discardableResult func mutate(_ method: NativeHTTPMethod, path: String, fields: [String: NativeJSON]) async -> Bool {
        let current = generation, reading = contentGeneration
        do {
            // Turning a request down reduces what runs, so the Host asks only that the device can see it.
            let declining = fields["decision"] == .string("reject") && connected && snapshot["device"]["status"].string == "active"
            guard declining || (path.hasPrefix("/link/api/approvals/") ? canApproveStandard || canApproveElevated || canRun : canRun) else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation, contentGeneration == reading else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            return await submit(try NativePendingWrite(method: method, path: path, fields: fields))
        }
        catch { report(error); return false }
    }
    func stop() async {
        guard workspace != nil, let id = sessionId else { return }
        var fields: [String: NativeJSON] = ["requestId": .string(UUID().uuidString)]
        let summary = snapshot["tasks"].array.first { $0["id"].string == id } ?? detail["summary"]
        if let run = summary["runId"].string { fields["runId"] = .string(run) }
        await performControl(path: Self.cancelPath(id), fields: fields)
    }
    func reject(_ id: String) async {
        guard workspace != nil else { return }
        await performControl(path: Self.approvalPath(id), fields: ["decision": .string("reject"), "requestId": .string(UUID().uuidString)])
    }
    func allow(_ id: String, option: String?) async {
        var fields: [String: NativeJSON] = ["decision": .string("allow")]
        if let option { fields["optionId"] = .string(option) }
        await mutate(.post, path: "/link/api/approvals/" + id, fields: fields)
    }
    /** One of 更多's choices: the option the Host named, kept with its requestId until it is answered. */
    func decide(_ id: String, option: String, allows: Bool) async {
        await mutate(.post, path: "/link/api/approvals/" + id, fields: ["decision": .string(allows ? "allow" : "reject"), "optionId": .string(option)])
    }
    /** 继续等 only ever asks the Host for a longer threshold; it doubles what the request saw. */
    func keepWaiting() async {
        let live = currentSummary["live"]
        guard let id = sessionId, let run = live["runId"].string, let threshold = live["silenceThresholdMs"].integer, let workspace else { return }
        do {
            _ = try await workspace.keepWaiting(sessionId: id, runId: run, thresholdMs: threshold)
            await refresh()
        } catch { if !wentAway(error) { report(error) } }
    }
}
