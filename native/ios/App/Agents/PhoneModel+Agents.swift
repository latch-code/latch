import Foundation
import LatchNativeCore

/** What became of a memory write. The Host is the authority: nothing shows as saved until it says so. */
enum PhoneAgentWrite: Equatable {
    case done, unknown, changed, refused(String)
}

struct CreatedHelper: Equatable {
    let requestId: String
    let id: String
}

extension PhoneModel {
    func agentDestination(_ owner: String?) -> PhoneAgentDestination {
        guard let owner, let agent = snapshot["customAgents"].array.first(where: { $0["id"].string == owner }) else { return .local }
        return PhoneAgentDestination(agent)
    }

    /** Connect with the destination registration's own keys. No content or writes from the source are passed. */
    func openAgentComputer(_ host: RegisteredHost, owner: String, target: String, source: UUID) async {
        guard generation == source, agentAccess == .ready, agentPath.first == owner, tab == .agents, !busy, !verifying,
              let current = selectedHost, agentDestination(owner).agentId(on: host.device.hostId, from: current.device.hostId) == target,
              !forgettingComputers.contains(host.id) else { return }
        let opening = UUID(); otherOpening = opening
        await connect(host, resumePreviousSession: false)
        guard otherOpening == opening, selectedHost?.id == host.id, tab == .agents, agentPath.isEmpty else { return }
        otherOpening = nil
        agentPath = [target]
    }
    func readAgentPart(_ path: String) async -> PhoneAgentRead {
        #if LATCH_SCREENS
        if staged { return ScreensStage.read(path) }
        #endif
        guard let workspace, connected else { return .offline }
        let current = generation, content = privateSnapshot.epoch
        let lease = await workspace.lease()
        guard current == generation, privateSnapshot.accepts(content), !Task.isCancelled else { return .loading }
        guard let lease, lease.valid else { return .closed }
        do {
            let value = try await workspace.read(path, body: true)
            guard current == generation, privateSnapshot.accepts(content), !Task.isCancelled else { return .loading }
            guard lease.valid, verifiedUntil != nil else { return .closed }
            return .ready(value)
        } catch {
            // A read superseded by a newer one (its task cancelled) says nothing about the Host: the newer one answers.
            guard current == generation, privateSnapshot.accepts(content), !Task.isCancelled, !(error is CancellationError) else { return .loading }
            let failure = PhoneAgents.readFailure(error)
            if failure == .offline { wentAway(error) }
            return failure
        }
    }
    /** A phone gets 我的 Agent only inside a content window, so the tab opens one as a conversation does. */
    func openAgents() async {
        #if LATCH_SCREENS
        if staged { return }
        #endif
        let host = generation
        guard workspace != nil, connected, !verifying, openingAgentsFor != host else { return }
        openingAgentsFor = host
        defer { if openingAgentsFor == host { openingAgentsFor = nil } }
        do {
            try await ensureVerified()
            guard host == generation, !Task.isCancelled else { return }
            _ = await refresh()
        } catch {
            guard host == generation, !Task.isCancelled, !(error is CancellationError), (error as? NativeFailure) != .declined else { return }
            if !wentAway(error) { report(error) }
        }
    }
    var agentAccess: PhoneAgentAccess {
        let reading = !offline && (snapshot == .null || verifying || openingAgentsFor == generation)
        return PhoneAgents.access(snapshot, windowOpen: hasContentWindow, privateConfirmed: privateSnapshot.confirmed, reading: reading)
    }
    func readAgent(_ id: String) async -> PhoneAgentRead {
        guard PhoneAgents.validId(id) else { return .missing }
        return await readAgentPart("/link/api/custom-agents/" + id)
    }
    /** 「电脑」 of an owner: what the Host recorded about its computer and the times its schedules missed. */
    func readComputer(_ owner: String) async -> PhoneAgentRead {
        guard let path = try? PhoneAgentComputer.path(owner: owner) else { return .missing }
        return await readAgentPart(path)
    }
    func readAutomation(_ id: String) async -> PhoneAgentRead {
        guard PhoneAgents.validAutomation(id) else { return .missing }
        return await readAgentPart("/link/api/automations/" + id)
    }
    /**
     * A write of 我的 Agent (a memory, a proposal's 保存 or 不要, 撤销 and 清除, a schedule's switch). It shares the one
     * unconfirmed write the phone keeps; a retry sends the same request.
     */
    func writeAgent(_ write: NativePendingWrite) async -> PhoneAgentWrite {
        #if LATCH_SCREENS
        if staged { return .done }
        #endif
        guard let workspace, !busy else { return .refused("稍后再试。") }
        guard canRun else { return .refused("这台设备不能修改。") }
        let current = generation
        do {
            try await ensureVerified()
            guard current == generation else { return .refused("稍后再试。") }
            let content = privateSnapshot.epoch, lease = await workspace.lease()
            guard current == generation, privateSnapshot.accepts(content), lease?.valid == true else { return .refused("请重新查看内容。") }
            guard pending.allSatisfy({ $0.requestId == write.requestId }) else { return .refused("上一项提交结果待确认，先确认它。") }
            busy = true; defer { if generation == current { busy = false } }
            if !pending.contains(where: { $0.requestId == write.requestId }) { pending.append(write) }
            let response = try await workspace.submit(write, explain: true, retryAnswered: PhoneAgentWrites.retryAnswered(write))
            guard current == generation else { return .done }
            pending.removeAll { $0.requestId == write.requestId }
            _ = await refresh()
            // Only the actual creation receipt supplies this identity; a retry away from the form never navigates.
            if current == generation, privateSnapshot.accepts(content), lease?.valid == true,
               PhoneHelperCreate.isCreation(write), let id = try? PhoneHelperCreate.createdId(response, for: write) {
                createdHelper = CreatedHelper(requestId: write.requestId, id: id)
            }
            return .done
        } catch is NativeUnsettledRefusal {
            // A retry the Host's words do not settle: still unknown, with the same request.
            return .unknown
        } catch let refusal as NativeHostRefusal {
            guard current == generation else { return .unknown }
            pending.removeAll { $0.requestId == write.requestId }
            // A schedule save is done when its proposal is saved and names the schedule, whatever this request heard.
            var proposals: [PhoneProposal]?
            if let owner = PhoneAgentWrites.owner(write), refusal.code == "agent-proposal-decided" { proposals = await readProposals(owner) }
            _ = await refresh()
            switch PhoneAgentWrites.outcome(write, refusal: refusal, proposals: proposals) {
            case .done: return .done
            case .changed: return .changed
            case let .refused(words): return .refused(words)
            }
        } catch {
            guard current == generation else { return .unknown }
            let failure = error as? NativeFailure
            if failure == .resultUnknown { return .unknown }
            pending.removeAll { $0.requestId == write.requestId }
            if failure == .changedElsewhere { return .changed }
            if failure == .expired { report(error) }
            return .refused(failure?.errorDescription ?? "没有保存，请重试。")
        }
    }
    /** An owner's proposals as the Host lists them now, without touching what the pages show. */
    func readProposals(_ owner: String) async -> [PhoneProposal]? {
        guard PhoneAgents.validId(owner), case let .ready(value) = await readAgentPart("/link/api/custom-agents/" + owner + "/proposals") else { return nil }
        return PhoneProposals.parse(value)
    }
    /**
     * 核对并放下 for a write of 我的 Agent: the Host's state decides what is shown, and this device's copy goes, so the one
     * pending write never blocks the others. Nil when nothing was dropped (busy, the Mac away, the window closed).
     */
    func checkAgentWrite(_ write: NativePendingWrite) async -> String? {
        guard pending.contains(where: { $0.requestId == write.requestId }), !busy, let workspace, connected else { return nil }
        let current = generation, content = privateSnapshot.epoch
        // Busy for the whole check, so no retry of the same request starts meanwhile.
        busy = true; defer { if generation == current { busy = false } }
        var proposals: [PhoneProposal]?
        if let owner = PhoneAgentWrites.owner(write) ?? PhoneAgentWrites.decisionOwner(write) {
            guard let read = await readProposals(owner) else { return nil }
            proposals = read
        }
        guard current == generation, privateSnapshot.accepts(content) else { return nil }
        do { try await workspace.settlePending(write.requestId) } catch { return nil }
        guard current == generation, privateSnapshot.accepts(content) else { return nil }
        pending.removeAll { $0.requestId == write.requestId }
        _ = await refresh()
        guard current == generation, privateSnapshot.accepts(content) else { return nil }
        if let owner = PhoneAgentWrites.owner(write) ?? PhoneAgentWrites.decisionOwner(write) { await loadProposals(owner) }
        guard current == generation, privateSnapshot.accepts(content) else { return nil }
        return PhoneAgentWrites.checkWords(write, proposals: proposals)
    }
    /** An owner's proposals, read again when the snapshot says they changed; nothing outside a window. */
    func loadProposals(_ owner: String) async {
        guard PhoneAgents.validId(owner), agentAccess == .ready else { proposals.drop(owner); return }
        // Only this owner's latest read is adopted; a lock or a closed window drops the token with the lists.
        let token = proposals.begin(owner)
        if case let .ready(value) = await readAgentPart("/link/api/custom-agents/" + owner + "/proposals") {
            proposals.finish(owner, token: token, list: value, windowOpen: verifiedUntil != nil)
        }
    }
    /** Result cards waiting for the owner's next topic, read when the snapshot says some wait; nothing outside a window. */
    func loadResults(_ owner: String) async {
        guard PhoneAgents.validId(owner), agentAccess == .ready, PhoneResults.waiting(snapshot, owner: owner), let path = try? PhoneResults.path(owner: owner) else {
            agentResults.drop(owner); return
        }
        let token = agentResults.begin(owner)
        if case let .ready(value) = await readAgentPart(path) {
            agentResults.finish(owner, token: token, value: PhoneResults.parse(value["results"]), windowOpen: verifiedUntil != nil)
        }
    }
    /** One page of 动态 or 资料库, the first or the one after the Host's cursor. */
    func readAgentPage(owner: String, part: String, before: String?) async -> PhoneAgentRead {
        guard let path = try? PhoneActivity.path(owner: owner, part: part, before: before) else { return .missing }
        return await readAgentPart(path)
    }
    /**
     * A new topic: the first message to an Agent (or 通用) starts its session through the same start as 新会话, with the same
     * request kept while its result is unknown. Only while the new topic is still what is shown does the answer open it.
     */
    func startTopic(owner: String, agent: NativeJSON, choice: PhoneStartChoice, prompt: String, attachments: [String] = [], fileRefs: [PhoneFileMatches.Hit] = []) async -> Bool {
        guard transportReady else { return false }
        let current = generation
        do {
            guard canRun, prompt.count <= 16_000, attachments.count <= PhoneAttachments.perMessage else { throw NativeFailure.forbidden }
            var fields = try topicFields(owner: owner, agent: agent, choice: choice, prompt: prompt)
            try attachStartFiles(fileRefs, to: &fields)
            if !attachments.isEmpty { fields["attachmentIds"] = .array(attachments.map { .string($0) }) }
            if sessionId != nil { closeSession() }
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            guard PhoneAgentChat.slot(snapshot, owner: owner)["state"].string == "empty" else { return false }
            return await finishTopic(try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fields))
        } catch { report(error); return false }
    }
    func topicFields(owner: String, agent: NativeJSON, choice: PhoneStartChoice, prompt: String) throws -> [String: NativeJSON] {
        let catalog = snapshot["catalog"]
        return owner == PhoneAgents.generalId ? try PhoneAgentChat.generalFields(catalog, choice: choice, prompt: prompt)
            : try PhoneAgents.fields(catalog, agent: agent, choice: choice, prompt: prompt)
    }
    /** The first try, or a retry of the very same request; true once the Host answered with the new topic, now open. */
    func finishTopic(_ write: NativePendingWrite) async -> Bool {
        guard await submit(write), pending.isEmpty, sessionId != nil else { return false }
        startEvents()
        return true
    }
}
