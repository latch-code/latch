import Foundation
import LatchNativeCore

extension PhoneModel {
    var canQueueCurrent: Bool { currentSummary["personal"]["groupId"].string == nil && (currentSummary["personal"] == .null ? snapshot["catalog"]["features"]["queue"].bool : snapshot["catalog"]["features"]["personalQueue"].bool) }
    var workspaceTasks: [NativeJSON] {
        snapshot["tasks"].array.filter { task in
            area == .personal ? task["personal"]["assistantId"].string == assistantId && task["personal"]["groupId"].string == nil
                : task["personal"]["assistantId"].string == nil
        }
    }
    var currentSummary: NativeJSON { snapshot["tasks"].array.first { $0["id"].string == sessionId } ?? detail["summary"] }
    func openProjects() {
        area = .projects; assistantId = nil; groupId = nil; groupControl = nil; groupDetail = .null; sessionId = nil; detail = .null; assistantDetail = .null
        contentGeneration = UUID(); PreviewFiles.clear(); startEvents()
    }
    private func performControl(path: String, fields: [String: NativeJSON]) async {
        guard let workspace else { return }
        let current = generation
        do {
            var body = fields
            if let saved = try await workspace.pendingControl() {
                var previous = saved["fields"].object, requested = fields
                previous.removeValue(forKey: "requestId"); requested.removeValue(forKey: "requestId")
                guard saved["path"].string == path, previous == requested else { throw NativeFailure.resultUnknown }
                body = saved["fields"].object
            }
            _ = try await workspace.freeAction(path: path, fields: body)
            guard generation == current else { return }
            await refreshControlPending(); _ = await refresh()
        } catch { if generation == current { await refreshControlPending(); report(error) } }
    }
    func openSession(_ id: String) async {
        guard let workspace else { return }
        let current = generation
        let reading = UUID()
        sessionId = id; detail = .null; contentGeneration = reading; PreviewFiles.clear()
        do {
            try await ensureVerified()
            guard current == generation, sessionId == id, contentGeneration == reading,
                  let lease = await workspace.lease() else { return }
            let value = try await workspace.detail(id)
            guard current == generation, sessionId == id, contentGeneration == reading else { return }
            try lease.requireValid()
            detail = value; startEvents()
        } catch { report(error) }
    }
    @discardableResult func send(text: String, queue: Bool = false) async -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 16_000 else { return false }
        let current = generation
        do {
            guard canRun else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            let path = sessionId.map { "/link/api/tasks/" + $0 + "/prompt" } ?? "/link/api/tasks"
            var fields: [String: NativeJSON] = ["prompt": .string(text)]
            if queue { fields["queue"] = .bool(true) }
            else if sessionId == nil {
                if area == .personal {
                    guard let assistantId else { throw NativeFailure.invalidRecord }
                    fields["assistantId"] = .string(assistantId)
                } else { fields["mode"] = .string("agent") }
            }
            return await submit(try NativePendingWrite(method: .post, path: path, fields: fields))
        } catch { report(error); return false }
    }
    @discardableResult func submit(_ request: NativePendingWrite) async -> Bool {
        guard let workspace, !busy else { return false }
        let current = generation, initialReading = contentGeneration
        do { try await ensureVerified() } catch { report(error); return false }
        guard current == generation, initialReading == contentGeneration else { return false }
        let selected = sessionId, reading = contentGeneration, owner = assistantId, surface = area
        busy = true; defer { if generation == current { busy = false } }
        do {
            if !pending.contains(where: { $0.requestId == request.requestId }) { pending.append(request) }
            let value = try await workspace.submit(request)
            guard generation == current else { return false }
            pending.removeAll { $0.requestId == request.requestId }
            guard contentGeneration == reading else { return false }
            if sessionId == selected, contentGeneration == reading, assistantId == owner, area == surface, let id = value["sessionId"].string { sessionId = id }
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
            guard (path.hasPrefix("/link/api/approvals/") ? canApproveStandard : canRun) else { throw NativeFailure.forbidden }
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
        await performControl(path: "/link/api/tasks/\(id)/cancel", fields: fields)
    }
    func reject(_ id: String) async {
        guard workspace != nil else { return }
        await performControl(path: "/link/api/approvals/" + id, fields: ["decision": .string("reject"), "requestId": .string(UUID().uuidString)])
    }
    func newSession() { sessionId = nil; detail = .null; contentGeneration = UUID(); PreviewFiles.clear(); startEvents() }
}
