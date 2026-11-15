import Foundation
import LatchNativeCore

/** What the composer of one place may attach: the Host's answer for one selection, or that it could not be read. */
struct PhoneAttachState: Equatable {
    var revision = ""
    var caps: PhoneAttachCaps?
    var failed = false
}

extension PhoneModel {
    /** The new-session sheet's place; a new topic's is by its owner; a session's is its ID. */
    static let newSessionTray = PhoneAttachments.newSessionKey
    static func topicTray(_ owner: String) -> String { PhoneAttachments.topicKey(owner) }
    func tray(_ key: String) -> PhoneAttachTray { attachTrays[key] ?? PhoneAttachTray() }
    /** While its message is being sent or is unconfirmed, a place's attachments stay as they are. */
    func attachLocked(_ key: String) -> Bool { PhoneAttachments.locked(key: key, pending: pending, sending: attachSending.contains(key)) }
    func attachState(_ key: String) -> PhoneAttachState { attachStates[key] ?? PhoneAttachState() }
    /** The selection an upload in a session is checked against: that session's own Harness and project. */
    func attachSelection(_ key: String) -> NativeJSON? {
        guard sessionOf(key) != nil else { return nil }
        let summary = summary(of: key)
        guard let harnessId = summary["harnessId"].string ?? (detail["summary"]["id"].string == key ? detail["summary"]["harnessId"].string : nil) else { return nil }
        return PhoneAttachments.selection(harnessId: harnessId, workspaceId: summary["workspaceId"].string,
            model: PhoneAgentChat.model(snapshot, task: summary))
    }
    /** Places that start a session (the sheet, a new topic) have no session ID yet. */
    private func sessionOf(_ key: String) -> String? { key.hasPrefix("\u{0}") ? nil : key }
    /** Reads what this place may attach again when the selection or the Harness's state changes; the same answer is kept meanwhile. */
    func loadAttachCaps(_ key: String, selection: NativeJSON?, harness: NativeJSON, asked: Bool = false) async {
        guard let workspace, let selection, canRun else { return }
        if verifiedUntil == nil {
            // The answer is read inside a window; with Face ID on, only a press of ＋ asks for one.
            guard asked || !PhoneFaceID.isOn else { return }
            do { try await ensureVerified() } catch { if asked, (error as? NativeFailure) != .declined { report(error) }; return }
        }
        let selected = (try? selection.encoded()).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let wanted = selected + "|" + PhoneAttachments.revision(harness)
        var state = attachState(key)
        guard state.revision != wanted || (state.caps == nil && !state.failed) else { return }
        // A new selection starts unknown; the same one read again keeps what it knew until the answer comes.
        if !state.revision.hasPrefix(selected + "|") { state.caps = nil }
        state.revision = wanted; state.failed = false; attachStates[key] = state
        let current = generation, reading = contentGeneration
        do {
            let caps = try await workspace.attachmentCapabilities(selection: selection, sessionId: sessionOf(key))
            guard generation == current, contentGeneration == reading, attachStates[key]?.revision == wanted else { return }
            attachStates[key]?.caps = caps
        } catch {
            guard generation == current, contentGeneration == reading, attachStates[key]?.revision == wanted else { return }
            attachStates[key]?.failed = true
            if [NativeFailure.expired, .forbidden, .contextChanged].contains(error as? NativeFailure) { report(error) }
        }
    }
    /** ＋ when nothing can be attached: the reason, next to the input. */
    func explainAttach(_ key: String, harness: NativeJSON, selection: NativeJSON?) {
        attachTrays[key, default: PhoneAttachTray()].note = PhoneAttachments.unavailable(caps: attachState(key).caps, harness: harness, failed: attachState(key).failed)
        guard attachState(key).caps == nil else { return }
        // Not read yet, or the read failed: read now, and say what the Host answers.
        if attachState(key).failed { attachStates[key]?.revision = "" }
        Task {
            await loadAttachCaps(key, selection: selection, harness: harness, asked: true)
            if attachTrays[key]?.note != nil, let caps = attachState(key).caps { attachTrays[key]?.note = caps.any ? nil : PhoneAttachments.unavailable(caps: caps, harness: harness, failed: false) }
        }
    }
    /** Checks each pick against the limits before any upload, then uploads the ones that fit, one at a time. */
    func addAttachments(_ key: String, pick: PhoneAttachPick, picked: [PhonePicked], selection: NativeJSON?) {
        var tray = tray(key)
        guard !attachLocked(key) else { tray.note = PhoneAttachments.lockedWords; attachTrays[key] = tray; return }
        tray.note = PhoneAttachments.pickNote(pick)
        // Nothing to add is said, never silent; a selection the Host cannot check against is said too.
        guard tray.note == nil, !picked.isEmpty else { attachTrays[key] = tray; return }
        guard let selection else { tray.note = PhoneAttachments.unavailable(caps: nil, harness: .null, failed: true); attachTrays[key] = tray; return }
        let caps = attachState(key).caps
        var added: [UUID] = []
        for item in picked {
            if let refusal = PhoneAttachments.admit(kind: item.kind, name: item.name, size: item.size, count: tray.items.count, caps: caps) { tray.note = refusal; continue }
            if let failure = item.failure { tray.note = failure; continue }
            guard let data = item.data, let kind = item.kind, let caps else { continue }
            if let refusal = PhoneAttachments.admitBytes(kind: kind, name: item.name, data: data, caps: caps) { tray.note = refusal; continue }
            // Every composer's waiting bytes together, this tray's as it is now.
            let staged = attachTrays.filter { $0.key != key }.values.reduce(tray.stagedBytes) { $0 + $1.stagedBytes }
            if let refusal = PhoneAttachments.admitStaged(staged: staged, adding: data.count) { tray.note = refusal; continue }
            let draft = PhoneAttachDraft(name: item.name, kind: kind, data: data)
            if tray.add(draft) { added.append(draft.id) }
        }
        attachTrays[key] = tray
        for id in added { startUpload(key, id: id, selection: selection) }
    }
    /** Uploads queue behind each other, as the workspace sends one at a time. */
    func startUpload(_ key: String, id: UUID, selection: NativeJSON, acknowledge: Bool = false) {
        guard let workspace, !attachLocked(key) else { return }
        if acknowledge { attachTrays[key]?.acknowledge(id) }
        attachTrays[key]?.set(id, .uploading(0))
        let current = generation, previous = uploadTail, sessionId = sessionOf(key)
        let job = Task { @MainActor in
            // Waiting behind the upload before it, yet a cancel of this row answers at once.
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await previous?.value }
                group.addTask { while !Task.isCancelled { try? await Task.sleep(for: .milliseconds(100)) } }
                await group.next(); group.cancelAll()
            }
            defer { if uploadJobs[id] != nil, generation == current { uploadJobs[id] = nil } }
            guard generation == current, let draft = attachTrays[key]?.items.first(where: { $0.id == id }) else { return }
            if Task.isCancelled { attachTrays[key]?.failed(id, refusal: nil, cancelled: true); return }
            do {
                let ref = try await workspace.uploadAttachment(draft, selection: selection, sessionId: sessionId, progress: { [weak self] done, total in
                    Task { @MainActor [weak self] in
                        guard let self, self.generation == current, case .uploading = self.attachTrays[key]?.items.first(where: { $0.id == id })?.status else { return }
                        self.attachTrays[key]?.set(id, .uploading(Double(done) / Double(max(1, total))))
                    }
                }, started: { [weak self] upload in
                    Task { @MainActor [weak self] in
                        guard let self, self.generation == current else { return }
                        // The row went meanwhile: what the Host began for it goes too.
                        if self.attachTrays[key]?.items.contains(where: { $0.id == id }) == true { self.attachTrays[key]?.started(id, upload: upload) }
                        else { await workspace.abortAttachmentUpload(upload) }
                    }
                })
                guard generation == current else { return }
                // Removed meanwhile: the Host's copy goes too.
                if attachTrays[key]?.ready(id, ref: ref) != true, let gone = ref["id"].string { Task { try? await workspace.removeAttachment(gone) } }
            } catch {
                guard generation == current else { return }
                let cancelled = error is CancellationError
                attachTrays[key]?.failed(id, refusal: error as? NativeHostRefusal, unknown: (error as? NativeFailure) == .resultUnknown, cancelled: cancelled)
                if let failure = error as? NativeFailure, failure != .resultUnknown {
                    if [.expired, .forbidden, .contextChanged].contains(failure) { report(failure) }
                    else { attachTrays[key]?.set(id, .failed(failure.errorDescription ?? "附件没有上传，可以重试。")) }
                }
            }
        }
        uploadJobs[id] = job
        uploadTail = job
    }
    /** Cancel closes this upload's stream and waits for it; the row can be tried again with the same request. */
    func cancelUpload(_ id: UUID) async {
        guard let job = uploadJobs[id] else { return }
        job.cancel(); await job.value
    }
    func removeAttachment(_ key: String, id: UUID) {
        guard !attachLocked(key) else { attachTrays[key]?.note = PhoneAttachments.lockedWords; return }
        uploadJobs[id]?.cancel(); uploadJobs[id] = nil
        // After 结果未知, a secret to confirm or a failure the Host may still hold parts: they are aborted there.
        guard let removed = attachTrays[key]?.removeRow(id), let workspace else { return }
        Task {
            if let attachment = removed.attachment { try? await workspace.removeAttachment(attachment) }
            if let upload = removed.upload { await workspace.abortAttachmentUpload(upload) }
        }
    }
    /**
     * Begins a send with attachments: the target and the rows are fixed now, the place is locked, and its uploads are
     * waited for. Afterwards the IDs go only to that same place with every one of those rows; otherwise the reason is said.
     * The caller ends it with `endAttachmentSend` whatever happens.
     */
    func attachmentsToSend(_ key: String, target: String?) async -> Result<[String], PhoneAttachBlock> {
        let plan = PhoneAttachSend(target: target, tray: tray(key))
        attachSending.insert(key)
        for job in plan.rows.compactMap({ uploadJobs[$0] }) { await job.value }
        let current = key.hasPrefix("\u{0}") ? nil : sessionId
        let result = plan.finish(current: current, tray: tray(key), caps: attachState(key).caps)
        if case let .failure(.reason(words)) = result { attachTrays[key, default: PhoneAttachTray()].note = words }
        return result
    }
    func endAttachmentSend(_ key: String) { attachSending.remove(key) }
    /** A place's composer went away: its uploads stop, and the Host's unsent drafts are dropped. */
    func dropAttachments(_ key: String) {
        guard let tray = attachTrays[key] else { return }
        for item in tray.items { uploadJobs[item.id]?.cancel(); uploadJobs[item.id] = nil }
        let uploads = tray.unfinishedUploads
        let ids = attachTrays[key]?.clear() ?? []
        attachTrays[key] = nil
        if let workspace {
            Task {
                for id in ids { try? await workspace.removeAttachment(id) }
                for upload in uploads { await workspace.abortAttachmentUpload(upload) }
            }
        }
    }
    /** The message went: its attachments now belong to the session. */
    func attachmentsSent(_ key: String) { attachTrays[key] = nil }
    /** Bytes in memory go with the window, the computer or the lock; the Host's drafts expire there on their own. */
    func clearAttachments() {
        for job in uploadJobs.values { job.cancel() }
        uploadJobs = [:]; uploadTail = nil; attachTrays = [:]; attachStates = [:]; attachSending = []
    }
}
