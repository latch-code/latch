import Foundation
import LatchNativeCore

/** The web's session actions, each through the Host's own route and the workspace's receipts. */
extension PhoneModel {
    func resetSessionActions() {
        clearing = []; subagentStops = PhoneSubagentStops(); forkDraft = nil; renaming = nil; deleting = nil; contentSearch = PhoneContentSearch(); showArchived = false
    }
    var canFork: Bool { canRun && snapshot["catalog"]["features"]["fork"].bool }
    var canSearchContent: Bool { snapshot["catalog"]["features"]["search"].bool && hasScope("view") }
    var openClearing: Bool { sessionId.map { clearing.contains($0) } ?? false }
    func summary(of id: String) -> NativeJSON { snapshot["tasks"].array.first { $0["id"].string == id } ?? (detail["summary"]["id"].string == id ? detail["summary"] : .null) }

    /** Any write built in the core: the same gates and receipts as a message. */
    @discardableResult func perform(_ make: () throws -> NativePendingWrite) async -> Bool {
        let current = generation, reading = contentGeneration
        do {
            guard canRun else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation, contentGeneration == reading else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            return await submit(try make())
        } catch { report(error); return false }
    }

    /** 停止 on one subagent's row, as the web's: 正在停止… until the Host says otherwise, gone on any failure or unknown answer. */
    func stopSubagent(_ id: String) async {
        guard let workspace, let session = sessionId else { return }
        let current = generation
        let outcome = await PhoneSubagentStops.run(id, get: { subagentStops }, set: { subagentStops = $0 }, current: { generation == current }) {
            try await ensureVerified()
            _ = try await workspace.stopSubagent(sessionId: session, subagentId: id)
        }
        guard let outcome, generation == current else { return }
        if case let .failure(error) = outcome, !wentAway(error) { report(error) }
        await refresh()
    }

    /** 从这里分叉: a new session's draft that keeps the source up to this turn. */
    func beginFork(turn index: Int, upTo messageId: String) {
        guard canFork, let id = sessionId else { return }
        let title = currentSummary["title"].string ?? detail["summary"]["title"].string ?? ""
        forkDraft = PhoneForkDraft(taskId: id, upToMessageId: messageId, title: title, turn: index + 1)
    }
    func startFork(_ draft: PhoneForkDraft, plan: PhoneForkPlan, prompt: String, fileRefs: [PhoneFileMatches.Hit] = []) async -> Bool {
        let current = generation
        do {
            guard canFork, prompt.count <= 16_000 else { throw NativeFailure.forbidden }
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            var fields = draft.fields(snapshot["catalog"], plan: plan, prompt: prompt)
            try attachStartFiles(fileRefs, to: &fields)
            sessionId = nil; detail = .null; contentGeneration = UUID()
            let done = await submit(try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fields))
            if done, sessionId != nil { startEvents() }
            return done
        } catch { report(error); return false }
    }

    /** 权限, 模型 or 思考: the Harness's own setting; the session shows the new value only once the Host reads it back. */
    func setConfig(_ configId: String, value: String) async {
        guard let id = sessionId else { return }
        let detail = self.detail
        await perform { try PhoneSessionConfig.write(sessionId: id, configId: configId, value: value, detail: detail) }
    }

    /** 清空上下文 marks the next message; 保留上下文 takes it back. Nothing goes to the Host until that message is sent. */
    func toggleClearing(_ id: String) {
        if clearing.contains(id) { clearing.remove(id) } else if !PhoneSessionMenu.active(summary(of: id)) { clearing.insert(id) }
    }

    func choose(_ action: PhoneMenuItem.Action, task: NativeJSON) async {
        guard let id = task["id"].string else { return }
        switch action {
        case .rename: renaming = task
        case .pin: await sessionAction { try PhoneSessionWrite.pin(id, pinned: !task["pinned"].bool) }
        case .clear: toggleClearing(id)
        case .archive:
            let archiving = !task["archived"].bool
            if await sessionAction({ try PhoneSessionWrite.archive(id, archived: archiving) }), archiving, sessionId == id { closeSession() }
        case .delete: deleting = task
        case .copy:
            guard detail["summary"]["id"].string == id else { return }
            LocalClipboard.copy(PhoneMarkdown.transcript(detail, harness: engineName(task["harnessId"].string)))
        }
    }
    @discardableResult func rename(_ task: NativeJSON, title: String) async -> Bool {
        guard let id = task["id"].string else { return false }
        return await sessionAction { try PhoneSessionWrite.rename(id, title: title) }
    }
    func delete(_ task: NativeJSON) async {
        guard transportReady, let id = task["id"].string else { return }
        // Off the session first: a read of what is being deleted would only fail.
        if sessionId == id { closeSession() }
        if await sessionAction({ try PhoneSessionWrite.remove(id) }) { clearing.remove(id); _ = heldDrafts.take(for: id) }
    }
    /**
     * Rename, pin, archive and delete as the web does them: one plain request, no receipt kept. Whatever the answer, the
     * list is read again, and what the Host lists is the truth; a failure or a lost answer is said once.
     */
    @discardableResult func sessionAction(_ make: () throws -> PhoneSessionRequest) async -> Bool {
        guard let workspace else { return false }
        let current = generation
        do {
            guard canRun, connected else { throw NativeFailure.forbidden }
            let request = try make()
            try await ensureVerified()
            guard current == generation else { return false }
            _ = try await workspace.sessionAction(request)
            guard current == generation else { return false }
            await refresh()
            return true
        } catch {
            guard current == generation else { return false }
            if (error as? NativeFailure) == .resultUnknown { self.error = "没有收到电脑的答复" } else { report(error) }
            await refresh()
            return false
        }
    }

    /**
     * 内容中包含: one search at a time, for the query it was asked for, inside the open window. The Host answers one search
     * at a time; a 429 keeps what was found and asks again after the same pause.
     */
    func searchContent(_ query: String) async {
        guard let q = PhoneSearch.query(query), canSearchContent, let workspace, verifiedUntil != nil else {
            contentSearch = PhoneContentSearch(query: query); return
        }
        let current = generation, reading = contentGeneration, window = privateSnapshot.epoch
        do {
            try await PhoneSearchRun.run(query, previous: contentSearch, search: { try await workspace.search(q) },
                pause: { try? await Task.sleep(for: .milliseconds(300)) }) { state in
                // A later query, another connection or a closed window drops what this one finds.
                guard !Task.isCancelled, current == generation, reading == contentGeneration, privateSnapshot.accepts(window),
                      canSearchContent, contentSearch.query == query || state.loading else { return false }
                contentSearch = state
                return true
            }
        } catch { if !Task.isCancelled, current == generation, privateSnapshot.accepts(window) { report(error) } }
    }
}
